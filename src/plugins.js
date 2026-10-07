import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as messages from './messages.js';
import {
  MARKETPLACE_NAME, compareVersions, restoreRegistry, snapshotRegistry, stripRegistration,
} from './registry.js';

export { MARKETPLACE_NAME };
const LIST_TIMEOUT_MS = 60000;
const HELP_TIMEOUT_MS = 30000;

// Older Claude Code releases reject these options with "unknown option", so the help
// text is checked first instead of failing on every plugin command.
const REQUIRED_OPTIONS = [
  { args: ['plugin', 'marketplace', 'add', '--help'], option: '--sparse' },
  { args: ['plugin', 'install', '--help'], option: '--scope' },
];

// `marketplace add <owner>/<name>` may be recorded as a git source with the full URL.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const githubRepoUrl = (repo) => new RegExp(`github\\.com[/:]${escapeRegExp(repo)}(\\.git)?$`, 'i');

export const formatClaudeCommand = (args) => `claude ${args.join(' ')}`;

// Plugins install once per developer, so a repo run never adds a project copy (container finding 4).
const PLUGIN_SCOPE = 'user';

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
    if (!carried.some((entry) => entry.name === name)) carried.push({ name, scope: PLUGIN_SCOPE });
  }
  return { reason: legacy ? 'legacy' : 'switch', carried, leftoverDirs: legacy?.leftoverDirs ?? [] };
}

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
 * carried plugin once at user scope; otherwise install the selected plugins missing at user
 * scope and update the installed ones that are behind the pinned release at their own scope.
 */
export function planPluginCommands({ selected, wanted, migration, installed, pinned }) {
  const add = { kind: 'marketplaceAdd', args: ['plugin', 'marketplace', 'add', ...wanted.addArgs] };
  if (migration) {
    const names = [...new Set(migration.carried.map(({ name }) => name))];
    return [add, ...names.map((name) => installStep({ name, scope: PLUGIN_SCOPE }))];
  }

  const installs = selected
    .filter((name) => !installed.some((entry) => entry.name === name && entry.scope === PLUGIN_SCOPE))
    .map((name) => installStep({ name, scope: PLUGIN_SCOPE }));
  const behind = installed.filter(({ name, version }) => compareVersions(version, pinned[name]) === -1);
  // Without a marketplace update, `plugin update` compares against the stale marketplace clone.
  const updates = behind.length
    ? [{ kind: 'marketplaceUpdate', args: ['plugin', 'marketplace', 'update', MARKETPLACE_NAME] }, ...behind.map(updateStep)]
    : [];
  if (installs.length === 0 && updates.length === 0) return [];
  return [add, ...installs, ...updates];
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

async function supportsPluginOptions({ exec, target }) {
  for (const { args, option } of REQUIRED_OPTIONS) {
    const result = await exec('claude', args, { cwd: target, timeoutMs: HELP_TIMEOUT_MS });
    if (result.code !== 0 || !result.stdout.includes(option)) return false;
  }
  return true;
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

const runStep = (exec, step, target) => exec('claude', step.args, { cwd: target, stdio: 'inherit' });

// All or nothing: on the first failing command the four registry files go back to the
// snapshot, so the plugins keep working from the old registration.
async function runMigration({ exec, plan, migration, paths, wanted, target, log, outcome }) {
  const snapshot = snapshotRegistry(paths);
  try {
    stripRegistration({ paths, carried: migration.carried, target });
  } catch (err) {
    restoreRegistry(snapshot);
    throw err;
  }

  const results = [];
  for (const [index, step] of plan.entries()) {
    const result = await runStep(exec, step, target);
    if (result.code === 0) {
      results.push({ step, status: 'ok' });
      continue;
    }
    restoreRegistry(snapshot);
    const command = formatClaudeCommand(step.args);
    log(messages.pluginFailed(command, result.code));
    outcome.rolledBack = { command, code: result.code };
    results.push({ step, status: 'failed', code: result.code });
    for (const rest of plan.slice(index + 1)) results.push({ step: rest, status: 'rolled-back' });
    return { results, outcome };
  }

  for (const dir of migration.leftoverDirs) fs.rmSync(dir, { recursive: true, force: true });
  if (migration.reason === 'legacy') outcome.migrated = plan.filter((step) => step.kind === 'install').length;
  if (wanted.kind === 'directory') outcome.localSource = wanted.path;
  return { results, outcome };
}

/**
 * Run the plan in `target`. Failures are collected, not thrown, so the deploy result still
 * stands. Returns {results, outcome}: one {step, status, code?} per step (ok, failed, skipped,
 * outdated when the claude CLI lacks an option the plan needs, rolled-back, or dry-run), and
 * the report outcome (migrated, rolledBack, localSource, updated; the caller fills ahead).
 */
export async function runPluginCommands({ exec, plan, migration, paths, wanted, dryRun, target, claudePresent, log }) {
  const outcome = { migrated: null, rolledBack: null, localSource: null, updated: [], ahead: [] };
  if (plan.length === 0) return { results: [], outcome };
  if (dryRun) {
    if (migration) log(messages.migrationDetected(migration.reason, migration.carried));
    for (const step of plan) log(formatClaudeCommand(step.args));
    return { results: plan.map((step) => ({ step, status: 'dry-run' })), outcome };
  }
  if (!claudePresent) {
    log(messages.pluginSkippedNoClaude);
    return { results: plan.map((step) => ({ step, status: 'skipped' })), outcome };
  }
  if (!(await supportsPluginOptions({ exec, target }))) {
    log(messages.pluginClaudeTooOld);
    return { results: plan.map((step) => ({ step, status: 'outdated' })), outcome };
  }
  if (migration) return runMigration({ exec, plan, migration, paths, wanted, target, log, outcome });

  const listed = await exec('claude', ['plugin', 'marketplace', 'list', '--json'], { cwd: target, timeoutMs: LIST_TIMEOUT_MS });
  const steps = listed.code === 0 && listsMarketplace(listed.stdout)
    ? plan.filter((step) => step.kind !== 'marketplaceAdd')
    : plan;

  const results = [];
  let updateFailed = false;
  for (const step of steps) {
    // The updates compare against the marketplace clone, so they cannot run after its update failed.
    if (step.kind === 'update' && updateFailed) {
      results.push({ step, status: 'failed' });
      continue;
    }
    const result = await runStep(exec, step, target);
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
