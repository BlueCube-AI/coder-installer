import fs from 'node:fs';
import path from 'node:path';

import * as clack from '@clack/prompts';

import { CliError, EXIT } from './cli.js';
import * as messages from './messages.js';

export const HIDDEN_GROUP = 'BlueCube Marketplace';
export const PLUGIN_PREFIX = 'plugin:';
const HINT_MAX = 90;

function unwrap(value) {
  if (clack.isCancel(value)) throw new CliError(EXIT.CANCELLED, messages.cancelled);
  return value;
}

/** Prompt adapter over @clack/prompts; a cancel (Ctrl+C) becomes CliError(CANCELLED). */
export function createPrompt() {
  return {
    confirm: async (opts) => unwrap(await clack.confirm(opts)),
    select: async (opts) => unwrap(await clack.select(opts)),
    groupMultiselect: async (opts) => unwrap(await clack.groupMultiselect(opts)),
  };
}

/** Prompt stand-in for --yes with every answer given: any question is a bug in the caller. */
export function createNonInteractivePrompt() {
  const refuse = async ({ message }) => {
    throw new CliError(EXIT.PREFLIGHT, messages.promptInNonInteractive(message));
  };
  return { confirm: refuse, select: refuse, groupMultiselect: refuse };
}

function shorten(text) {
  const oneLine = (text || '').replace(/\s+/g, ' ').trim();
  return oneLine.length > HINT_MAX ? `${oneLine.slice(0, HINT_MAX - 3)}...` : oneLine;
}

function withBadge(label, experimental) {
  if (!experimental || /experimental/i.test(label)) return label;
  return `${label} (${messages.experimentalBadge})`;
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

export async function chooseScope({ options, prompt }) {
  if (options.scope) return options.scope;
  return prompt.select({
    message: messages.scopePrompt,
    options: [
      { value: 'repo', label: messages.scopeRepoLabel, hint: messages.scopeRepoHint(options.cwd) },
      { value: 'homedir', label: messages.scopeHomedirLabel, hint: messages.scopeHomedirHint },
    ],
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
      plugins: (data.plugins || []).map((plugin) => ({ name: plugin.name, description: plugin.description || '' })),
    };
  } catch {
    return null;
  }
}

/**
 * Flat, ordered option list for the category picker. Categories come grouped by the first
 * appearance of their group, then in catalog order; the plugin marketplace group comes last.
 */
export function buildOptions(catalog, scope, marketplace) {
  const byGroup = new Map();
  for (const cat of catalog.categories) {
    if (!cat.scope.includes(scope) || cat.group === HIDDEN_GROUP) continue;
    if (!byGroup.has(cat.group)) byGroup.set(cat.group, []);
    byGroup.get(cat.group).push({
      value: cat.id,
      label: withBadge(cat.label, cat.experimental),
      hint: shorten(cat.desc),
      group: cat.group,
      selected: Boolean(cat.default),
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
        selected: false,
      });
    }
  }
  return options;
}

/** Return the selected option values (category ids and plugin:<name> ids). */
export async function chooseCategories({ options, prompt, requested, scope, agent }) {
  if (options.length === 0) throw new CliError(EXIT.OK, messages.categoriesNone(scope, agent));

  const valid = options.map((option) => option.value);
  if (requested) {
    const unknown = requested.filter((id) => !valid.includes(id));
    if (unknown.length) throw new CliError(EXIT.PREFLIGHT, messages.categoriesUnknown(unknown, scope, agent, valid));
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
