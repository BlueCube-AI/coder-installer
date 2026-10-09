import fs from 'node:fs';
import path from 'node:path';

import * as clack from '@clack/prompts';

import { CliError, EXIT, installDir, isOwnerName } from './cli.js';
import * as messages from './messages.js';

export const HIDDEN_GROUP = 'BlueCube Marketplace';
export const PLUGIN_PREFIX = 'plugin:';
const HINT_MAX = 90;
// Notifications pop up and speak through TTS whenever Claude needs attention, so a client package
// leaves them for the developer to pick.
const CLIENT_OPT_IN = ['notification'];

function unwrap(value) {
  if (clack.isCancel(value)) throw new CliError(EXIT.CANCELLED, messages.cancelled);
  return value;
}

/** Prompt adapter over @clack/prompts; a cancel (Ctrl+C) becomes CliError(CANCELLED). */
export function createPrompt() {
  return {
    confirm: async (opts) => unwrap(await clack.confirm(opts)),
    select: async (opts) => unwrap(await clack.select(opts)),
    text: async (opts) => unwrap(await clack.text(opts)),
    groupMultiselect: async (opts) => unwrap(await clack.groupMultiselect(opts)),
  };
}

/** Prompt stand-in for --yes with every answer given: any question is a bug in the caller. */
export function createNonInteractivePrompt() {
  const refuse = async ({ message }) => {
    throw new CliError(EXIT.PREFLIGHT, messages.promptInNonInteractive(message));
  };
  return { confirm: refuse, select: refuse, text: refuse, groupMultiselect: refuse };
}

function shorten(text) {
  const oneLine = (text || '').replace(/\s+/g, ' ').trim();
  return oneLine.length > HINT_MAX ? `${oneLine.slice(0, HINT_MAX - 3)}...` : oneLine;
}

function withBadge(label, experimental) {
  if (!experimental || /experimental/i.test(label)) return label;
  return `${label} (${messages.experimentalBadge})`;
}

/**
 * Ask where to install from: the developer's client repository (owner/name), or the full SDK
 * for BlueCube staff. Returns the repository as owner/name or the SDK's git URL.
 */
export async function chooseRepository({ prompt, sdkRepo }) {
  const choice = await prompt.select({
    message: messages.repoPrompt,
    options: [
      { value: 'client', label: messages.repoClientLabel },
      { value: 'sdk', label: messages.repoSdkLabel },
    ],
    initialValue: 'client',
  });
  if (choice === 'sdk') return sdkRepo;
  const repo = await prompt.text({
    message: messages.repoNamePrompt,
    placeholder: messages.repoNamePlaceholder,
    validate: (value) => (isOwnerName((value ?? '').trim()) ? undefined : messages.repoNameInvalid),
  });
  return repo.trim();
}

export function buildHarnessOptions({ detected, agents, ref }) {
  const supported = new Map(agents.map((agent) => [agent.name, agent]));
  return detected.map((harness) => {
    const agent = supported.get(harness.name);
    if (!agent) {
      return { value: harness.name, label: harness.name, hint: messages.harnessUnsupportedHint(ref), disabled: true };
    }
    return {
      value: agent.name,
      label: withBadge(agent.displayName, agent.experimental),
      hint: harness.path,
      disabled: false,
    };
  });
}

/** Pick the agent to install for. Returns the catalog's agent entry. */
export async function chooseHarness({ detected, agents, prompt, requested, ref, log }) {
  const supported = new Map(agents.map((agent) => [agent.name, agent]));
  if (requested) {
    const agent = supported.get(requested);
    if (!agent) throw new CliError(EXIT.UNSUPPORTED_HARNESS, messages.harnessUnsupported(requested, ref));
    return agent;
  }
  if (detected.length === 0) throw new CliError(EXIT.PREFLIGHT, messages.harnessNoneDetected);

  const options = buildHarnessOptions({ detected, agents, ref });
  const selectable = options.filter((option) => !option.disabled);
  if (selectable.length === 0) {
    throw new CliError(EXIT.UNSUPPORTED_HARNESS, messages.harnessUnsupported(options[0].value, ref));
  }
  if (selectable.length === 1) {
    for (const option of options.filter((o) => o.disabled)) log(messages.harnessUnsupported(option.value, ref));
    const agent = supported.get(selectable[0].value);
    log(messages.harnessAuto(agent.displayName));
    return agent;
  }
  const name = await prompt.select({ message: messages.harnessPrompt, options, initialValue: selectable[0].value });
  return supported.get(name);
}

export async function chooseScope({ options, prompt, agent, projectOnly = [] }) {
  if (options.scope) return options.scope;
  const dir = (scope) => installDir({ scope, agent, cwd: options.cwd, target: options.target });
  const home = { value: 'homedir', label: messages.scopeHomedirLabel(dir('homedir')) };
  if (projectOnly.length) home.hint = messages.projectOnlyNotAvailable(projectOnly.map(({ label }) => label));
  return prompt.select({
    message: messages.scopePrompt,
    options: [{ value: 'repo', label: messages.scopeRepoLabel(dir('repo')) }, home],
    initialValue: 'repo',
  });
}

/** Warn before a repo install into a directory that is not a git work tree. */
export async function confirmRepoTarget({ exec, target, prompt, yes, log }) {
  if (fs.existsSync(target)) {
    const probe = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: target, timeoutMs: 30000 });
    if (probe.code === 0 && probe.stdout.trim() === 'true') return;
  }
  log(messages.targetNotGit(target));
  if (yes) return;
  const accepted = await prompt.confirm({ message: messages.targetNotGitConfirm, initialValue: false });
  if (!accepted) throw new CliError(EXIT.CANCELLED, messages.cancelled);
}

/** Read the Claude Code plugin marketplace committed in the SDK checkout, or null. */
export function readMarketplace(root) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
    return {
      name: data.name,
      plugins: (data.plugins || []).map((plugin) => ({
        name: plugin.name,
        description: plugin.description || '',
        version: plugin.version || null,
      })),
    };
  } catch {
    return null;
  }
}

// The list comes from the pinned catalog and is never hardcoded, so an older SDK yields none.
export function projectOnlyCategories(catalog) {
  return catalog.categories
    .filter((cat) => cat.scope.includes('repo') && !cat.scope.includes('homedir') && cat.group !== HIDDEN_GROUP)
    .map(({ id, label }) => ({ id, label }));
}

/**
 * Flat, ordered option list for the category picker. Categories come grouped by the first
 * appearance of their group, then in catalog order; the plugin marketplace group comes last.
 * A client package offers only what the client gets, so its pre-selection follows the scope: a
 * repo run starts with every category but the opt-in ones, a home run with every plugin. Plugins
 * install for every project, so a project install leaves them alone unless picked.
 */
export function buildOptions(catalog, scope, marketplace, { clientPackage = false } = {}) {
  const byGroup = new Map();
  for (const cat of catalog.categories) {
    if (!cat.scope.includes(scope) || cat.group === HIDDEN_GROUP) continue;
    if (!byGroup.has(cat.group)) byGroup.set(cat.group, []);
    const label = withBadge(cat.label, cat.experimental);
    byGroup.get(cat.group).push({
      value: cat.id,
      label: scope === 'repo' && !cat.scope.includes('homedir') ? `${label} (${messages.projectOnlyBadge})` : label,
      hint: shorten(cat.desc),
      group: cat.group,
      selected: clientPackage ? scope === 'repo' && !CLIENT_OPT_IN.includes(cat.id) : Boolean(cat.default),
    });
  }
  const options = [...byGroup.values()].flat();
  if (catalog.agent === 'claude-code' && marketplace) {
    for (const plugin of marketplace.plugins) {
      options.push({
        value: `${PLUGIN_PREFIX}${plugin.name}`,
        label: plugin.name,
        hint: shorten(plugin.description),
        group: messages.pluginsGroup,
        selected: clientPackage && scope === 'homedir',
      });
    }
  }
  return options;
}

/** Return the selected option values (category ids and plugin:<name> ids). */
export async function chooseCategories({ options, prompt, requested, scope, agent, projectOnly = [], scopeFlag = null }) {
  if (options.length === 0) throw new CliError(EXIT.OK, messages.categoriesNone(scope, agent));

  const valid = options.map((option) => option.value);
  if (requested) {
    const refused = scope === 'homedir'
      ? requested.map((id) => projectOnly.find((entry) => entry.id === id)).filter(Boolean)
      : [];
    const unknown = requested.filter((id) => !valid.includes(id) && !refused.some((entry) => entry.id === id));
    if (unknown.length) throw new CliError(EXIT.PREFLIGHT, messages.categoriesUnknown(unknown, scope, agent, valid));
    if (refused.length) throw new CliError(EXIT.PREFLIGHT, messages.projectOnlyRefused(refused, scopeFlag));
    return requested;
  }

  const grouped = {};
  for (const { group, value, label, hint } of options) {
    (grouped[group] ??= []).push({ value, label, hint });
  }
  const ask = (message) => prompt.groupMultiselect({
    message,
    options: grouped,
    initialValues: options.filter((option) => option.selected).map((option) => option.value),
    required: false,
  });

  let selected = await ask(messages.categoriesPrompt);
  if (selected.length === 0) selected = await ask(messages.categoriesEmptyRetry);
  if (selected.length === 0) throw new CliError(EXIT.CANCELLED, messages.cancelled);
  return selected;
}
