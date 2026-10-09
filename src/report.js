import { installDir } from './cli.js';
import * as messages from './messages.js';
import { formatClaudeCommand } from './plugins.js';

const HOOK_CATEGORIES = ['damage_control', 'notification'];
const PENDING_PLUGIN_STATUSES = ['failed', 'skipped', 'outdated'];

/** Lines to print after a successful install. */
export function nextSteps({ agent, scope, categories, pluginResults, outcome = {}, projectOnly = [] }) {
  const lines = [messages.nextStepSession(agent.displayName)];
  if (scope === 'homedir' && projectOnly.length) {
    lines.push(messages.projectOnlyNotAvailable(projectOnly.map(({ label }) => label)));
  }
  if (typeof outcome.migrated === 'number') lines.push(messages.migrated(outcome.migrated));
  if (outcome.rolledBack) lines.push(messages.migrationRolledBack(outcome.rolledBack.command, outcome.rolledBack.code));
  if (outcome.localSource) lines.push(messages.pluginsLocalSource(outcome.localSource));
  if (outcome.updated?.length) lines.push(messages.pluginsUpdated(outcome.updated));
  if (outcome.ahead?.length) lines.push(messages.pluginsAhead(outcome.ahead));
  // SDK 1.1.0 never writes hooks at home.
  if (scope === 'repo' && categories.some((id) => HOOK_CATEGORIES.includes(id))) {
    lines.push(messages.nextStepHooks(`${agent.configDir}/settings.json`));
  }
  // A by-hand `marketplace add` would hit the old registration: after a rollback the rollback
  // line explains the state, and a pending migration needs the installer itself.
  if (outcome.migrationPending) {
    lines.push(messages.migrationPending);
    return lines;
  }
  if (pluginResults.some(({ status }) => status === 'outdated')) {
    lines.push(messages.nextStepUpdateClaude);
  }
  if (outcome.rolledBack) return lines;
  for (const { step, status } of pluginResults) {
    if (PENDING_PLUGIN_STATUSES.includes(status)) {
      lines.push(messages.nextStepPlugin(formatClaudeCommand(step.args)));
    }
  }
  return lines;
}

/** What the run installed, as [{heading, items}]; plugins always sit under every project. */
export function installedBlocks({ scope, agent, target, targetGiven, categoryLabels, pluginNames }) {
  const blocks = scope === 'repo'
    ? [
      { heading: messages.installedHere(installDir({ scope: 'repo', agent, target })), items: categoryLabels },
      { heading: messages.installedEverywhere(installDir({ scope: 'homedir', agent, target: null })), items: pluginNames },
    ]
    : [{
      heading: messages.installedEverywhere(installDir({ scope: 'homedir', agent, target: targetGiven ? target : null })),
      items: [...categoryLabels, ...pluginNames],
    }];
  return blocks.filter(({ items }) => items.length);
}

export function printSummary(blocks, lines, log) {
  for (const { heading, items } of blocks) {
    log('');
    log(heading);
    for (const item of items) log(`  - ${item}`);
  }
  log('');
  log(messages.nextStepsHeading);
  for (const line of lines) log(`  - ${line}`);
}
