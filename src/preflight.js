import os from 'node:os';
import path from 'node:path';

import { CliError, EXIT } from './cli.js';
import * as messages from './messages.js';

const GIT_PROBE_TIMEOUT_MS = 30000;

// From https://docs.astral.sh/uv/getting-started/installation/
export const UV_INSTALL = {
  posix: { display: 'curl -LsSf https://astral.sh/uv/install.sh | sh', cmd: 'sh', args: ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'] },
  win32: {
    display: 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
    cmd: 'powershell',
    args: ['-ExecutionPolicy', 'ByPass', '-c', 'irm https://astral.sh/uv/install.ps1 | iex'],
  },
};

/**
 * Return the path of uv, offering to run the official installer when it is missing.
 * Throws CliError(PREFLIGHT) when the user declines or the install does not produce uv.
 */
export async function ensureUv({ exec, which, prompt, yes, platform = process.platform, log, homedir = os.homedir() }) {
  const found = which('uv');
  if (found) return found;

  const install = platform === 'win32' ? UV_INSTALL.win32 : UV_INSTALL.posix;
  log(messages.uvMissing(install.display));
  const accepted = yes || await prompt.confirm({ message: messages.uvConfirm, initialValue: true });
  if (!accepted) throw new CliError(EXIT.PREFLIGHT, messages.uvDeclined);

  const result = await exec(install.cmd, install.args, { stdio: 'inherit' });
  if (result.code !== 0) throw new CliError(EXIT.PREFLIGHT, messages.uvInstallFailed);

  // The installer updates PATH for new shells only; look where it puts uv.
  const installDirs = [path.join(homedir, '.local', 'bin'), path.join(homedir, '.cargo', 'bin')];
  const pathSeparator = platform === 'win32' ? ';' : ':';
  const installed = which('uv') ?? which('uv', { pathEnv: installDirs.join(pathSeparator), platform });
  if (!installed) throw new CliError(EXIT.PREFLIGHT, messages.uvNotOnPath);
  return installed;
}

/** Probe read access to the SDK repository without ever prompting for credentials. */
export async function ensureGitAccess({ exec, which, url }) {
  if (!which('git')) throw new CliError(EXIT.PREFLIGHT, messages.gitMissing);
  const result = await exec('git', ['ls-remote', '--exit-code', url, 'HEAD'], { timeoutMs: GIT_PROBE_TIMEOUT_MS });
  if (result.code !== 0 || result.timedOut) {
    throw new CliError(EXIT.PREFLIGHT, messages.gitAccessFailed(url, result.stderr, result.timedOut));
  }
}
