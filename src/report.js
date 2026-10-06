import * as messages from './messages.js';
import { formatClaudeCommand } from './plugins.js';

const HOOK_CATEGORIES = ['damage_control', 'notification'];
const PENDING_PLUGIN_STATUSES = ['failed', 'skipped', 'outdated'];

/** Lines to print after a successful install. */
export function nextSteps({ agent, scope, categories, pluginResults, outcome = {} }) {
  const lines = [messages.nextStepSession(agent.displayName)];
  if (typeof outcome.migrated === 'number') lines.push(messages.migrated(outcome.migrated));
  if (outcome.rolledBack) lines.push(messages.migrationRolledBack(outcome.rolledBack.command, outcome.rolledBack.code));
  if (outcome.localSource) lines.push(messages.pluginsLocalSource(outcome.localSource));
  if (outcome.updated?.length) lines.push(messages.pluginsUpdated(outcome.updated));
  if (outcome.ahead?.length) lines.push(messages.pluginsAhead(outcome.ahead));
  if (categories.some((id) => HOOK_CATEGORIES.includes(id))) {
    const configRoot = scope === 'homedir' ? agent.homedirPath : agent.configDir;
    lines.push(messages.nextStepHooks(`${configRoot}/settings.json`));
  }
  if (pluginResults.some(({ status }) => status === 'outdated')) {
    lines.push(messages.nextStepUpdateClaude);
  }
  // After a rollback the by-hand commands would hit the same legacy conflict; the rollback
  // line explains the state instead.
  if (outcome.rolledBack) return lines;
  for (const { step, status } of pluginResults) {
    if (PENDING_PLUGIN_STATUSES.includes(status)) {
      lines.push(messages.nextStepPlugin(formatClaudeCommand(step.args)));
    }
  }
  return lines;
}

export function printSummary(lines, log) {
  log('');
  log(messages.nextStepsHeading);
  for (const line of lines) log(`  - ${line}`);
}
