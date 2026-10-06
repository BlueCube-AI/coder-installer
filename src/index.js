import fs from 'node:fs';
import os from 'node:os';

import { CliError, EXIT, defaultTarget, parseCli } from './cli.js';
import { DEFAULT_AGENT, readCatalog } from './catalog.js';
import { buildDeployArgs, runDeploy } from './deploy.js';
import { detectHarnesses } from './detect.js';
import { run, which } from './exec.js';
import * as messages from './messages.js';
import {
  PLUGIN_PREFIX, buildOptions, chooseCategories, chooseHarness, chooseScope,
  confirmRepoTarget, createNonInteractivePrompt, createPrompt, readMarketplace,
} from './picker.js';
import {
  aheadPlugins, planMigration, planPluginCommands, runPluginCommands, wantedSource,
} from './plugins.js';
import { ensureGitAccess, ensureUv } from './preflight.js';
import { claudeConfigDir, installedPlugins, readRegistration, registryPaths } from './registry.js';
import { nextSteps, printSummary } from './report.js';
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

// Read the Claude Code plugin registry and plan the plugin steps. Only claude-code runs get
// here: Pi and OpenCode never read or write the registry.
function planPlugins({ deps, options, scope, target, selected, marketplace }) {
  const configDir = claudeConfigDir({ env: deps.env, homedir: deps.homedir });
  const registry = { configDir, target, scope };
  const paths = registryPaths(registry);
  const registration = readRegistration(registry);
  const installed = installedPlugins(registry);
  const wanted = wantedSource(options.sdkUrl);
  const pinned = Object.fromEntries((marketplace?.plugins ?? []).map((plugin) => [plugin.name, plugin.version]));
  const migration = planMigration({ registration, installed, wanted, selected, scope });
  const plan = planPluginCommands({ selected, scope, wanted, migration, installed, pinned });
  return { plan, migration, paths, wanted, installed, pinned };
}

async function install(options, deps) {
  const { exec, which: whichFn, log, pkg } = deps;
  const prompt = options.nonInteractive ? createNonInteractivePrompt() : deps.prompt;

  log(messages.intro(pkg.version));
  const detected = detectHarnesses({ which: whichFn });

  // Preflight: nothing is written to disk before these pass.
  const uvPath = await ensureUv({
    exec, which: whichFn, prompt, yes: options.yes, platform: deps.platform, log, homedir: deps.homedir,
  });
  if (deps.resolved) deps.resolved.uv = uvPath;
  await ensureGitAccess({ exec, which: whichFn, url: options.sdkUrl });

  const source = await resolveSource({
    exec, cacheDir: options.cacheDir, url: options.sdkUrl, ref: options.ref, log,
    confirm: prompt.confirm, yes: options.yes,
  });

  log(messages.catalogReading);
  const firstCatalog = await readCatalog({ exec, root: source.root, agent: DEFAULT_AGENT, ref: options.ref });
  const agent = await chooseHarness({
    detected, agents: firstCatalog.agents, prompt, requested: options.agent, ref: options.ref, log,
  });
  const catalog = agent.name === firstCatalog.agent
    ? firstCatalog
    : await readCatalog({ exec, root: source.root, agent: agent.name, ref: options.ref });

  const scope = await chooseScope({ options, prompt });
  const target = options.target ?? defaultTarget(scope, options);
  if (scope === 'repo') await confirmRepoTarget({ exec, target, prompt, yes: options.yes, log });

  const marketplace = agent.name === 'claude-code' ? readMarketplace(source.root) : null;
  const choices = buildOptions(catalog, scope, marketplace);
  const selected = await chooseCategories({
    options: choices, prompt, requested: options.categories, scope, agent: agent.name,
  });
  const categories = selected.filter((id) => !id.startsWith(PLUGIN_PREFIX));
  const plugins = selected.filter((id) => id.startsWith(PLUGIN_PREFIX)).map((id) => id.slice(PLUGIN_PREFIX.length));

  if (categories.length) {
    const args = buildDeployArgs({ scope, agent: agent.name, categories, target, targetGiven: options.targetGiven });
    const code = await runDeploy({ exec, root: source.root, args, dryRun: options.dryRun, log });
    if (code !== 0) throw new CliError(EXIT.DEPLOY_FAILED, messages.deployFailed(code));
  }

  const pluginPlan = agent.name === 'claude-code'
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
  printSummary(nextSteps({ agent, scope, categories, pluginResults, outcome }), log);
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
