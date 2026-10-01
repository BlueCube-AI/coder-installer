/** argv for `uv` that runs the SDK's headless deploy from the checked-out slot. */
export function buildDeployArgs({ scope, agent, categories, target, targetGiven }) {
  const args = [
    'run', 'sdk/deploy.py', '--non-interactive',
    '--mode', scope,
    '--agent', agent,
    '--categories', categories.join(','),
  ];
  // In homedir scope deploy.py picks the home target itself, so a later fix to its
  // per-agent default reaches the installer without a change here.
  if (scope === 'repo' || targetGiven) args.push('--target', target);
  return args;
}

/** Run the deploy with inherited output and return its exit code. */
export async function runDeploy({ exec, root, args, dryRun, log }) {
  if (dryRun) {
    log(`uv ${args.join(' ')}`);
    return 0;
  }
  const result = await exec('uv', args, { cwd: root, stdio: 'inherit' });
  return result.code;
}
