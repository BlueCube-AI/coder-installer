import * as messages from './messages.js';
import { formatClaudeCommand } from './plugins.js';

const HOOK_CATEGORIES = ['damage_control', 'notification'];

/** Lines to print after a successful install. */
export function nextSteps({ agent, scope, categories, pluginResults }) {
  const lines = [messages.nextStepSession(agent.displayName)];
  if (categories.some((id) => HOOK_CATEGORIES.includes(id))) {
    const configRoot = scope === 'homedir' ? agent.homedirPath : agent.configDir;
    lines.push(messages.nextStepHooks(`${configRoot}/settings.json`));
  }
  for (const { step, status } of pluginResults) {
    if (status === 'failed' || status === 'skipped') {
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
