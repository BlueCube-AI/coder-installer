import * as messages from './messages.js';

export const MARKETPLACE_NAME = 'bluecube-coder';
const LIST_TIMEOUT_MS = 60000;

export const formatClaudeCommand = (args) => `claude ${args.join(' ')}`;

/** Ordered claude CLI steps that install the selected marketplace plugins. */
export function planPluginCommands({ selected, scope }) {
  if (selected.length === 0) return [];
  const pluginScope = scope === 'homedir' ? 'user' : 'project';
  return [
    {
      kind: 'marketplaceAdd',
      args: ['plugin', 'marketplace', 'add', messages.MARKETPLACE_REPO, '--sparse', '.claude-plugin', 'plugins'],
    },
    ...selected.map((name) => ({
      kind: 'install',
      plugin: name,
      args: ['plugin', 'install', `${name}@${MARKETPLACE_NAME}`, '--scope', pluginScope],
    })),
  ];
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

/**
 * Run the plan in `target`. Failures are collected, not thrown, so the deploy result
 * still stands. Returns one {step, status, code?} per step: ok, failed, skipped or dry-run.
 */
export async function runPluginCommands({ exec, plan, dryRun, target, claudePresent, log }) {
  if (plan.length === 0) return [];
  if (dryRun) {
    for (const step of plan) log(formatClaudeCommand(step.args));
    return plan.map((step) => ({ step, status: 'dry-run' }));
  }
  if (!claudePresent) {
    log(messages.pluginSkippedNoClaude);
    return plan.map((step) => ({ step, status: 'skipped' }));
  }

  const listed = await exec('claude', ['plugin', 'marketplace', 'list', '--json'], { cwd: target, timeoutMs: LIST_TIMEOUT_MS });
  const steps = listed.code === 0 && listsMarketplace(listed.stdout)
    ? plan.filter((step) => step.kind !== 'marketplaceAdd')
    : plan;

  const results = [];
  for (const step of steps) {
    const result = await exec('claude', step.args, { cwd: target, stdio: 'inherit' });
    if (result.code === 0) {
      results.push({ step, status: 'ok' });
    } else {
      log(messages.pluginFailed(formatClaudeCommand(step.args), result.code));
      results.push({ step, status: 'failed', code: result.code });
    }
  }
  return results;
}
