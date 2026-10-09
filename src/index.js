import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliError, EXIT, defaultTarget, parseCli, repositorySource } from './cli.js';
import { DEFAULT_AGENT, readCatalog } from './catalog.js';
import { buildDeployArgs, runDeploy } from './deploy.js';
import { detectHarnesses } from './detect.js';
import { run, which } from './exec.js';
import * as messages from './messages.js';
import { isNewer, readClientPackage, readInstalledManifest } from './package.js';
import {
  PLUGIN_PREFIX, buildOptions, chooseCategories, chooseHarness, chooseRepository, chooseScope,
  confirmRepoTarget, createNonInteractivePrompt, createPrompt, projectOnlyCategories, readMarketplace,
} from './picker.js';
import {
  aheadPlugins, installedPluginNames, planMigration, planPluginCommands, runPluginCommands, unofferedPlugins,
  wantedSource,
} from './plugins.js';
import { ensureGitAccess, ensureUv } from './preflight.js';
import { claudeConfigDir, installedPlugins, readRegistration, registryPaths } from './registry.js';
import { installedBlocks, nextSteps, printSummary } from './report.js';
import { resolveSource } from './source.js';

const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export function defaultDeps() {
  // Commands are spawned through the absolute path `which` found (uv.exe, claude.cmd on
  // Windows). `resolved` lets preflight point `uv` at a fresh install that is not on PATH yet.
  const resolved = {};
  return {
    exec: (cmd, args, opts) => run(resolved[cmd] ?? which(cmd) ?? cmd, args, opts),
    which,
    resolved,
    prompt: createPrompt(),
    env: process.env,
    platform: process.platform,
    cwd: process.cwd(),
    homedir: os.homedir(),
    log: (line) => process.stdout.write(`${line}\n`),
    logError: (line) => process.stderr.write(`${line}\n`),
    pkg: PKG,
  };
}

const NO_PLUGINS = { plan: [], migration: null, paths: null, wanted: null, installed: [], pinned: {} };

// Read the Claude Code plugin registry and plan the plugin steps. Only claude-code runs that
// picked a plugin get here: Pi and OpenCode never read or write the registry.
function planPlugins({ deps, options, scope, target, selected, marketplace }) {
  const wanted = wantedSource(options.sdkUrl, options.repoSlug);
  if (!wanted) {
    deps.log(messages.pluginSkippedNoSource(options.sdkUrl));
    return NO_PLUGINS;
  }
  const configDir = claudeConfigDir({ env: deps.env, homedir: deps.homedir });
  const registry = { configDir, target, scope };
  const paths = registryPaths(registry);
  const registration = readRegistration(registry);
  const installed = installedPlugins(registry);
  const pinned = Object.fromEntries((marketplace?.plugins ?? []).map((plugin) => [plugin.name, plugin.version]));
  const migration = planMigration({ registration, installed, wanted, selected });
  const unoffered = unofferedPlugins({ migration, marketplace });
  if (unoffered.length) {
    const source = wanted.kind === 'github' ? wanted.repo : wanted.path;
    deps.log(messages.pluginsNotOffered(source, unoffered, migration.reason));
    return NO_PLUGINS;
  }
  const plan = planPluginCommands({ selected, wanted, migration, installed, pinned });
  return { plan, migration, paths, wanted, installed, pinned };
}

// A run without a repository asks for one, or refuses when it may not ask.
async function withRepository(options, { prompt, pkg, env }) {
  if (options.sdkUrl) return options;
  if (options.nonInteractive) throw new CliError(EXIT.PREFLIGHT, messages.repoRequired);
  const repo = await chooseRepository({ prompt, sdkRepo: pkg.bluecube.sdkRepo });
  return { ...options, ...repositorySource(repo, pkg, { env, ref: options.ref }) };
}

async function install(given, deps) {
  const { exec, which: whichFn, log, pkg } = deps;
  const prompt = given.nonInteractive ? createNonInteractivePrompt() : deps.prompt;

  log(messages.intro(pkg.version));
  const options = await withRepository(given, { prompt, pkg, env: deps.env });
  const detected = detectHarnesses({ which: whichFn });

  // Preflight: nothing is written to disk before these pass.
  const uvPath = await ensureUv({
    exec, which: whichFn, prompt, yes: options.yes, platform: deps.platform, log, homedir: deps.homedir,
  });
  if (deps.resolved) deps.resolved.uv = uvPath;
  await ensureGitAccess({ exec, which: whichFn, url: options.sdkUrl, repo: options.repoSlug });

  const source = await resolveSource({
    exec, cacheDir: options.cacheDir, url: options.sdkUrl, ref: options.ref, log,
    confirm: prompt.confirm, yes: options.yes,
  });
  const clientPackage = readClientPackage(source.root);

  log(messages.catalogReading);
  const firstCatalog = await readCatalog({ exec, root: source.root, agent: DEFAULT_AGENT, ref: options.ref });
  const agent = await chooseHarness({
    detected, agents: firstCatalog.agents, prompt, requested: options.agent, ref: options.ref, log,
  });
  const catalog = agent.name === firstCatalog.agent
    ? firstCatalog
    : await readCatalog({ exec, root: source.root, agent: agent.name, ref: options.ref });
  const projectOnly = projectOnlyCategories(catalog);

  const scope = await chooseScope({ options, prompt, agent, projectOnly });
  const target = options.target ?? defaultTarget(scope, options);
  // The headless deploy writes SDK_MANIFEST.json under <target>/<configDir> in both scopes.
  const installed = readInstalledManifest(path.join(target, agent.configDir));
  if (isNewer(clientPackage, installed)) log(messages.newerPackage(clientPackage, installed));
  if (scope === 'repo') await confirmRepoTarget({ exec, target, prompt, yes: options.yes, log });

  const marketplace = agent.name === 'claude-code' ? readMarketplace(source.root) : null;
  const choices = buildOptions(catalog, scope, marketplace, { clientPackage: clientPackage !== null });
  const selected = await chooseCategories({
    options: choices, prompt, requested: options.categories, scope, agent: agent.name,
    projectOnly, scopeFlag: options.scopeFlag,
  });
  const categories = selected.filter((id) => !id.startsWith(PLUGIN_PREFIX));
  const plugins = selected.filter((id) => id.startsWith(PLUGIN_PREFIX)).map((id) => id.slice(PLUGIN_PREFIX.length));

  if (categories.length) {
    const args = buildDeployArgs({ scope, agent: agent.name, categories, target, targetGiven: options.targetGiven });
    const code = await runDeploy({ exec, root: source.root, args, dryRun: options.dryRun, log });
    if (code !== 0) throw new CliError(EXIT.DEPLOY_FAILED, messages.deployFailed(code));
  }

  // Plugins install for every project, so a run that picks none leaves them as they are: no
  // marketplace move, install or update.
  const pluginPlan = agent.name === 'claude-code' && plugins.length
    ? planPlugins({ deps, options, scope, target, selected: plugins, marketplace })
    : NO_PLUGINS;
  const claudePresent = Boolean(whichFn('claude'));
  const { results: pluginResults, outcome } = await runPluginCommands({
    exec,
    plan: pluginPlan.plan,
    migration: pluginPlan.migration,
    paths: pluginPlan.paths,
    wanted: pluginPlan.wanted,
    dryRun: options.dryRun,
    target,
    claudePresent,
    log,
  });
  if (options.dryRun) return EXIT.OK;

  // Without claude the installed versions are not acted on, so they are not reported either.
  if (!pluginPlan.migration && claudePresent) outcome.ahead = aheadPlugins(pluginPlan);
  const categoryLabels = categories.map((id) => catalog.categories.find((cat) => cat.id === id).label);
  // No marketplace source (a Pi or OpenCode run, or a skipped plugin step): no plugins.
  const pluginNames = pluginPlan.wanted
    ? installedPluginNames({ selected: plugins, migration: pluginPlan.migration, results: pluginResults, outcome })
    : [];
  printSummary(
    installedBlocks({ scope, agent, target, targetGiven: options.targetGiven, categoryLabels, pluginNames }),
    nextSteps({ agent, scope, categories, pluginResults, outcome, projectOnly }),
    log,
  );
  return outcome.rolledBack ? EXIT.DEPLOY_FAILED : EXIT.OK;
}

export async function main(argv, deps = defaultDeps()) {
  try {
    const options = parseCli(argv, deps.pkg, { env: deps.env, cwd: deps.cwd, homedir: deps.homedir });
    if (options.help) {
      deps.log(messages.usage('bluecube-coder'));
      return EXIT.OK;
    }
    if (options.version) {
      deps.log(deps.pkg.version);
      return EXIT.OK;
    }
    return await install(options, deps);
  } catch (err) {
    if (err instanceof CliError) {
      if (err.message) (err.code === EXIT.OK ? deps.log : deps.logError)(err.message);
      return err.code;
    }
    deps.logError(messages.unexpectedError(err?.message ?? String(err)));
    if (deps.env?.DEBUG && err?.stack) deps.logError(err.stack);
    return EXIT.DEPLOY_FAILED;
  }
}
