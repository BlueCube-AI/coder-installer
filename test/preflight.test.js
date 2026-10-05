import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CliError, EXIT } from '../src/cli.js';
import * as messages from '../src/messages.js';
import { UV_INSTALL, ensureGitAccess, ensureUv } from '../src/preflight.js';
import { collectLog, fakeExec, fakePrompt, fakeWhich } from './helpers.js';

const isPreflight = (err) => err instanceof CliError && err.code === EXIT.PREFLIGHT;

describe('ensureUv', () => {
  it('should return the uv path when it is present', async () => {
    const exec = fakeExec();
    assert.equal(await ensureUv({ exec, which: fakeWhich(['uv']), prompt: fakePrompt(), log: collectLog() }), '/usr/bin/uv');
    assert.equal(exec.calls.length, 0);
  });

  it('should exit 2 when uv is missing and the offer is declined', async () => {
    const exec = fakeExec();
    const log = collectLog();
    await assert.rejects(
      ensureUv({ exec, which: fakeWhich([]), prompt: fakePrompt({ confirm: false }), log, platform: 'darwin' }),
      (err) => isPreflight(err) && err.message === messages.uvDeclined,
    );
    assert.equal(exec.calls.length, 0);
    assert.match(log.lines[0], /curl -LsSf https:\/\/astral\.sh\/uv\/install\.sh \| sh/);
  });

  it('should run the posix command when accepted', async () => {
    const exec = fakeExec();
    const which = (name) => (exec.calls.length && name === 'uv' ? '/home/u/.local/bin/uv' : null);
    const uv = await ensureUv({ exec, which, prompt: fakePrompt({ confirm: true }), log: collectLog(), platform: 'linux' });
    assert.equal(uv, '/home/u/.local/bin/uv');
    assert.deepEqual(exec.calls[0], { cmd: UV_INSTALL.posix.cmd, args: UV_INSTALL.posix.args, opts: { stdio: 'inherit' } });
  });

  it('should run the PowerShell command on win32 under --yes without asking', async () => {
    const exec = fakeExec();
    const prompt = fakePrompt();
    const which = (name) => (exec.calls.length && name === 'uv' ? 'C:\\u\\uv.exe' : null);
    await ensureUv({ exec, which, prompt, yes: true, log: collectLog(), platform: 'win32' });
    assert.equal(exec.calls[0].cmd, 'powershell');
    assert.deepEqual(exec.calls[0].args, ['-ExecutionPolicy', 'ByPass', '-c', 'irm https://astral.sh/uv/install.ps1 | iex']);
    assert.equal(prompt.asked.length, 0);
  });

  it('should exit 2 when the install command fails', async () => {
    const exec = fakeExec(() => ({ code: 1 }));
    await assert.rejects(
      ensureUv({ exec, which: fakeWhich([]), prompt: fakePrompt(), yes: true, log: collectLog(), platform: 'linux' }),
      (err) => isPreflight(err) && err.message === messages.uvInstallFailed,
    );
  });
});

describe('ensureGitAccess', () => {
  const url = 'https://github.com/BlueCube-AI/bluecube-coder.git';

  it('should exit 2 when git is missing', async () => {
    await assert.rejects(
      ensureGitAccess({ exec: fakeExec(), which: fakeWhich([]), url }),
      (err) => isPreflight(err) && err.message === messages.gitMissing,
    );
  });

  it('should probe with ls-remote and a 30 second timeout', async () => {
    const exec = fakeExec();
    await ensureGitAccess({ exec, which: fakeWhich(['git']), url });
    assert.deepEqual(exec.calls[0], { cmd: 'git', args: ['ls-remote', '--exit-code', url, 'HEAD'], opts: { timeoutMs: 30000 } });
  });

  it('should exit 2 with the gh steps and the git stderr on failure', async () => {
    const exec = fakeExec(() => ({ code: 128, stderr: 'fatal: Authentication failed' }));
    await assert.rejects(ensureGitAccess({ exec, which: fakeWhich(['git']), url }), (err) => {
      assert.ok(isPreflight(err));
      assert.match(err.message, /gh auth login/);
      assert.match(err.message, /gh auth setup-git/);
      assert.match(err.message, /SSH/);
      assert.match(err.message, /    fatal: Authentication failed/);
      assert.doesNotMatch(err.message, /cannot see this repository/);
      return true;
    });
  });

  it('should exit 2 with the account steps when GitHub says the repository is not found', async () => {
    const stderr = "remote: Repository not found.\nfatal: repository 'https://github.com/BlueCube-AI/bluecube-coder.git/' not found";
    const exec = fakeExec(() => ({ code: 128, stderr }));
    await assert.rejects(ensureGitAccess({ exec, which: fakeWhich(['git']), url }), (err) => {
      assert.ok(isPreflight(err));
      assert.equal(err.message, messages.gitNoAccess(url, stderr));
      assert.match(err.message, /cannot see this repository/);
      assert.match(err.message, /gh auth status/);
      assert.match(err.message, /gh auth setup-git/);
      assert.match(err.message, /    remote: Repository not found\./);
      return true;
    });
  });

  it('should exit 2 on timeout', async () => {
    const exec = fakeExec(() => ({ code: 124, timedOut: true }));
    await assert.rejects(ensureGitAccess({ exec, which: fakeWhich(['git']), url }), (err) => isPreflight(err) && /timed out/.test(err.message));
  });
});
