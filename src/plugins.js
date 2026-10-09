import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as messages from './messages.js';
import {
  MARKETPLACE_NAME, compareVersions, parkMarketplace, restoreMarketplace, restoreRegistry, snapshotRegistry,
  stripRegistration,
} from './registry.js';

export { MARKETPLACE_NAME };
const LIST_TIMEOUT_MS = 60000;
const HELP_TIMEOUT_MS = 30000;

// Older Claude Code releases reject these options with "unknown option", so the help
// text is checked first instead of failing on every plugin command.
const REQUIRED_OPTIONS = [
  { args: ['plugin', 'marketplace', 'add', '--help'], options: ['--sparse', '--scope'] },
  { args: ['plugin', 'install', '--help'], options: ['--scope'] },
];
// Where Claude Code's own installers put claude: the native install, and the older local install
// that shells reach through an alias.
const NATIVE_CLAUDE_DIRS = [['.local', 'bin'], ['.claude', 'local']];

// `marketplace add <owner>/<name>` may be recorded as a git source with the full URL.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const githubRepoUrl = (repo) => new RegExp(`github\\.com[/:]${escapeRegExp(repo)}(\\.git)?$`, 'i');

export const formatClaudeCommand = (args) => `claude ${args.join(' ')}`;

// A home run installs for every project, a repo run for its project only. A marketplace move is
// machine-wide, so the plugins it carries go back at user scope.
const USER_SCOPE = 'user';
const PROJECT_SCOPE = 'project';
const pluginScopeFor = (scope) => (scope === 'repo' ? PROJECT_SCOPE : USER_SCOPE);

/**
 * Every claude the run could use, in order: each one on PATH, then the native install locations.
 * npx puts the node_modules/.bin of every parent folder ahead of PATH, and a shell alias is
 * invisible here, so the first claude on PATH can be an old copy the developer's shell never runs.
 */
export function claudeCandidates({ which, env, homedir, platform }) {
  const lib = platform === 'win32' ? path.win32 : path.posix;
  const pathDirs = (env?.PATH ?? env?.Path ?? '').split(lib.delimiter);
  const nativeDirs = NATIVE_CLAUDE_DIRS.map((parts) => lib.join(homedir, ...parts));
  const found = [...pathDirs, ...nativeDirs].filter(Boolean).map((dir) => which('claude', { pathEnv: dir, platform }));
  return [...new Set(found.filter(Boolean))];
}

/**
 * The marketplace source this run registers: the local checkout for a file:// URL, whose
 * plugins then load in place, else the GitHub repository the run installs from. Null for any
 * other URL: the run has no marketplace to register.
 */
export function wantedSource(sdkUrl, repoSlug) {
  if (sdkUrl.startsWith('file://')) {
    const checkout = fileURLToPath(sdkUrl);
    return { kind: 'directory', path: checkout, addArgs: [checkout] };
  }
  if (!repoSlug) return null;
  return { kind: 'github', repo: repoSlug, addArgs: [repoSlug, '--sparse', '.claude-plugin', 'plugins'] };
}

export function sourceMatches(declared, wanted) {
  if (!declared) return false;
  if (wanted.kind === 'directory') {
    return declared.source === 'directory' && typeof declared.path === 'string'
      && path.resolve(declared.path) === path.resolve(wanted.path);
  }
  if (declared.source === 'github') {
    return typeof declared.repo === 'string' && declared.repo.toLowerCase() === wanted.repo.toLowerCase();
  }
  return declared.source === 'git' && typeof declared.url === 'string' && githubRepoUrl(wanted.repo).test(declared.url);
}

/**
 * Re-register the marketplace when the declaration is legacy or its source is not the wanted
 * one. Returns null to keep the registration, else {reason, carried, leftoverDirs}: the plugin
 * entries to strip at their scopes and the legacy copies to delete once everything succeeded.
 */
export function planMigration({ registration, installed, wanted, selected }) {
  const { declared, legacy } = registration;
  if (!legacy && (!declared || sourceMatches(declared, wanted))) return null;

  const carried = [];
  for (const { name, scope: pluginScope } of legacy ? legacy.plugins : installed) {
    if (!carried.some((entry) => entry.name === name && entry.scope === pluginScope)) {
      carried.push({ name, scope: pluginScope });
    }
  }
  // The strip matches entries by scope, so carried entries keep theirs; every carried plugin is
  // reinstalled at user scope.
  for (const name of selected) {
    if (!carried.some((entry) => entry.name === name)) carried.push({ name, scope: USER_SCOPE });
  }
  return { reason: legacy ? 'legacy' : 'switch', carried, leftoverDirs: legacy?.leftoverDirs ?? [] };
}

const describeSource = (source) => source.repo ?? source.url ?? source.path ?? source.source;

/**
 * The source of the machine's bluecube-coder marketplace when it is not the wanted one, as text
 * for the report, else null. The marketplace is one per machine: adding another source for one
 * project would move it, and with it the plugins of every project, so a repo run stops here.
 */
export function conflictingSource({ registration, known, wanted }) {
  if (registration.legacy) return messages.legacySourceLabel;
  for (const source of [registration.declared, known]) {
    if (source && !sourceMatches(source, wanted)) return describeSource(source);
  }
  return null;
}

/**
 * Carried plugins the wanted marketplace does not list, such as a full SDK plugin on a move to a
 * client repository. Their reinstall would fail and roll the whole migration back.
 */
export function unofferedPlugins({ migration, marketplace }) {
  if (!migration) return [];
  const offered = new Set((marketplace?.plugins ?? []).map(({ name }) => name));
  return migration.carried.filter(({ name }) => !offered.has(name));
}

// A project-scope add declares the marketplace in the project's settings, where a teammate's
// Claude Code finds it; `plugin install --scope project` alone does not write it there.
const marketplaceAddStep = (wanted, scope) => ({
  kind: 'marketplaceAdd',
  scope,
  args: ['plugin', 'marketplace', 'add', ...wanted.addArgs, ...(scope === PROJECT_SCOPE ? ['--scope', scope] : [])],
});

const installStep = ({ name, scope }) => ({
  kind: 'install',
  plugin: name,
  scope,
  args: ['plugin', 'install', `${name}@${MARKETPLACE_NAME}`, '--scope', scope],
});

const updateStep = ({ name, scope }) => ({
  kind: 'update',
  plugin: name,
  scope,
  args: ['plugin', 'update', `${name}@${MARKETPLACE_NAME}`, '--scope', scope],
});

/** Installed plugins newer than the pinned release, with the pinned version for the report. */
export function aheadPlugins({ installed, pinned }) {
  return installed
    .filter(({ name, version }) => compareVersions(version, pinned[name]) === 1)
    .map((entry) => ({ ...entry, pinned: pinned[entry.name] }));
}

/**
 * Ordered claude CLI steps: with a migration, add the wanted marketplace and reinstall each
 * carried plugin once at user scope; otherwise add it at the run's plugin scope, install the
 * selected plugins missing there and update the ones there that are behind the pinned release.
 * A repo run touches project-scope installs of its target only, never the user-scope ones.
 */
export function planPluginCommands({ selected, scope, wanted, migration, installed, pinned }) {
  if (migration) {
    const names = [...new Set(migration.carried.map(({ name }) => name))];
    return [marketplaceAddStep(wanted, USER_SCOPE), ...names.map((name) => installStep({ name, scope: USER_SCOPE }))];
  }

  const pluginScope = pluginScopeFor(scope);
  const own = installed.filter((entry) => entry.scope === pluginScope);
  const installs = selected
    .filter((name) => !own.some((entry) => entry.name === name))
    .map((name) => installStep({ name, scope: pluginScope }));
  const behind = own.filter(({ name, version }) => compareVersions(version, pinned[name]) === -1);
  // Without a marketplace update, `plugin update` compares against the stale marketplace clone.
  const updates = behind.length
    ? [{ kind: 'marketplaceUpdate', args: ['plugin', 'marketplace', 'update', MARKETPLACE_NAME] }, ...behind.map(updateStep)]
    : [];
  if (installs.length === 0 && updates.length === 0) return [];
  return [marketplaceAddStep(wanted, pluginScope), ...installs, ...updates];
}

/**
 * Plugin names the summary lists: the selected and carried ones, minus those whose install did
 * not succeed. After a rollback the restore undid every install, so none.
 */
export function installedPluginNames({ selected, migration, results, outcome }) {
  if (outcome.rolledBack) return [];
  const names = [...new Set([...selected, ...(migration?.carried ?? []).map(({ name }) => name)])];
  return names.filter((name) => !results.some(({ step, status }) => step.kind === 'install' && step.plugin === name && status !== 'ok'));
}

async function supportsPluginOptions({ exec, claude, target }) {
  for (const { args, options } of REQUIRED_OPTIONS) {
    const result = await exec(claude, args, { cwd: target, timeoutMs: HELP_TIMEOUT_MS });
    if (result.code !== 0 || !options.every((option) => result.stdout.includes(option))) return false;
  }
  return true;
}

/**
 * The first candidate whose plugin commands take every option the plan passes. Returns
 * {claude, checked}: claude is null when none does, and checked names each rejected one with
 * its version for the report.
 */
async function pickClaude({ exec, candidates, target }) {
  const checked = [];
  for (const candidate of candidates) {
    if (await supportsPluginOptions({ exec, claude: candidate, target })) return { claude: candidate, checked };
    const result = await exec(candidate, ['--version'], { cwd: target, timeoutMs: HELP_TIMEOUT_MS });
    const version = result.code === 0 ? result.stdout.trim().split(/\s+/)[0] || null : null;
    checked.push({ path: candidate, version });
  }
  return { claude: null, checked };
}

function listsMarketplace(stdout) {
  try {
    const data = JSON.parse(stdout);
    const entries = Array.isArray(data) ? data : (data.marketplaces ?? []);
    return entries.some((entry) => entry?.name === MARKETPLACE_NAME);
  } catch {
    return false;
  }
}

const runStep = (exec, claude, step, target) => exec(claude, step.args, { cwd: target, stdio: 'inherit' });

// All or nothing: on the first failing command the four registry files go back to the
// snapshot and the old marketplace copy goes back in place, so the plugins keep working from
// the old registration.
async function runMigration({ exec, claude, plan, migration, paths, wanted, target, log, outcome }) {
  const snapshot = snapshotRegistry(paths);
  let parked;
  try {
    stripRegistration({ paths, carried: migration.carried, target });
    // Last, so a failure above leaves the copy where it is.
    parked = parkMarketplace(paths);
  } catch (err) {
    restoreRegistry(snapshot);
    throw err;
  }

  const results = [];
  for (const [index, step] of plan.entries()) {
    const result = await runStep(exec, claude, step, target);
    if (result.code === 0) {
      results.push({ step, status: 'ok' });
      continue;
    }
    restoreRegistry(snapshot);
    restoreMarketplace(paths, parked);
    const command = formatClaudeCommand(step.args);
    log(messages.pluginFailed(command, result.code));
    outcome.rolledBack = { command, code: result.code };
    results.push({ step, status: 'failed', code: result.code });
    for (const rest of plan.slice(index + 1)) results.push({ step: rest, status: 'rolled-back' });
    return { results, outcome };
  }

  for (const dir of [...migration.leftoverDirs, parked].filter(Boolean)) fs.rmSync(dir, { recursive: true, force: true });
  if (migration.reason === 'legacy') outcome.migrated = plan.filter((step) => step.kind === 'install').length;
  if (wanted.kind === 'directory') outcome.localSource = wanted.path;
  return { results, outcome };
}

/**
 * Run the plan in `target` with the first of `claudePaths` (see claudeCandidates) that takes
 * the options the plan needs. Failures are collected, not thrown, so the deploy result still
 * stands. Returns {results, outcome}: one {step, status, code?} per step (ok, failed, skipped,
 * outdated when no claude CLI has an option the plan needs, rolled-back, or dry-run), and the
 * report outcome (migrated, rolledBack, migrationPending, localSource, updated; the caller
 * fills ahead).
 */
export async function runPluginCommands({ exec, plan, migration, paths, wanted, dryRun, target, claudePaths, log }) {
  const outcome = {
    migrated: null, rolledBack: null, migrationPending: false, localSource: null, updated: [], ahead: [],
  };
  if (plan.length === 0) return { results: [], outcome };
  if (dryRun) {
    if (migration) log(messages.migrationDetected(migration.reason, migration.carried));
    for (const step of plan) log(formatClaudeCommand(step.args));
    return { results: plan.map((step) => ({ step, status: 'dry-run' })), outcome };
  }
  // Only the installer can strip the old registration, so a skipped migration is not left to
  // by-hand commands: `marketplace add` refuses while settings declare another source.
  if (claudePaths.length === 0) {
    log(messages.pluginSkippedNoClaude);
    outcome.migrationPending = Boolean(migration);
    return { results: plan.map((step) => ({ step, status: 'skipped' })), outcome };
  }
  const { claude, checked } = await pickClaude({ exec, candidates: claudePaths, target });
  if (!claude) {
    log(messages.pluginClaudeTooOld(checked));
    outcome.migrationPending = Boolean(migration);
    return { results: plan.map((step) => ({ step, status: 'outdated' })), outcome };
  }
  if (migration) return runMigration({ exec, claude, plan, migration, paths, wanted, target, log, outcome });

  // A project-scope add always runs: it is what declares the marketplace in the project's settings.
  let steps = plan;
  if (plan.some((step) => step.kind === 'marketplaceAdd' && step.scope === USER_SCOPE)) {
    const listed = await exec(claude, ['plugin', 'marketplace', 'list', '--json'], { cwd: target, timeoutMs: LIST_TIMEOUT_MS });
    if (listed.code === 0 && listsMarketplace(listed.stdout)) steps = plan.filter((step) => step.kind !== 'marketplaceAdd');
  }

  const results = [];
  let updateFailed = false;
  for (const step of steps) {
    // The updates compare against the marketplace clone, so they cannot run after its update failed.
    if (step.kind === 'update' && updateFailed) {
      results.push({ step, status: 'failed' });
      continue;
    }
    const result = await runStep(exec, claude, step, target);
    if (result.code === 0) {
      results.push({ step, status: 'ok' });
      if (step.kind === 'update') outcome.updated.push(step.plugin);
    } else {
      log(messages.pluginFailed(formatClaudeCommand(step.args), result.code));
      results.push({ step, status: 'failed', code: result.code });
      if (step.kind === 'marketplaceUpdate') updateFailed = true;
    }
  }
  return { results, outcome };
}
