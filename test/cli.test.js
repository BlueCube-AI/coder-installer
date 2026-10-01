import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { CliError, EXIT, parseCli } from '../src/cli.js';
import { main } from '../src/index.js';
import { collectLog, fakeExec, fakePrompt, fakeWhich } from './helpers.js';

const PKG = { version: '9.9.9', bluecube: { sdkRepo: 'https://example.test/sdk.git', sdkRef: 'v0.6.1' } };
const CTX = { env: {}, cwd: '/work/project', homedir: '/home/dev' };

describe('parseCli', () => {
  it('should default the ref to bluecube.sdkRef', () => {
    assert.equal(parseCli([], PKG, CTX).ref, 'v0.6.1');
  });

  it('should let --ref override the pinned ref', () => {
    assert.equal(parseCli(['--ref', 'feature/x'], PKG, CTX).ref, 'feature/x');
  });

  it('should map -g to the homedir scope', () => {
    assert.equal(parseCli(['-g'], PKG, CTX).scope, 'homedir');
    assert.equal(parseCli(['--global', '--scope', 'homedir'], PKG, CTX).scope, 'homedir');
  });

  it('should leave the scope unset without -g or --scope', () => {
    assert.equal(parseCli([], PKG, CTX).scope, null);
  });

  it('should throw a preflight error for conflicting scope flags', () => {
    assert.throws(() => parseCli(['-g', '--scope', 'repo'], PKG, CTX), (err) => err instanceof CliError && err.code === EXIT.PREFLIGHT);
  });

  it('should reject an unknown scope and an unknown flag', () => {
    assert.throws(() => parseCli(['--scope', 'global'], PKG, CTX), { code: EXIT.PREFLIGHT });
    assert.throws(() => parseCli(['--nope'], PKG, CTX), { code: EXIT.PREFLIGHT });
  });

  it('should resolve --target against the cwd', () => {
    const options = parseCli(['--target', 'sub'], PKG, CTX);
    assert.equal(options.target, path.resolve('/work/project', 'sub'));
    assert.equal(options.targetGiven, true);
    assert.equal(parseCli([], PKG, CTX).target, null);
  });

  it('should split --categories on commas', () => {
    assert.deepEqual(parseCli(['--categories', 'git, context,,'], PKG, CTX).categories, ['git', 'context']);
  });

  it('should detect non-interactive mode only when every answer is given', () => {
    const full = ['--yes', '--agent', 'pi', '--scope', 'repo', '--categories', 'git'];
    assert.equal(parseCli(full, PKG, CTX).nonInteractive, true);
    assert.equal(parseCli(['-y', '--agent', 'pi', '-g', '--categories', 'git'], PKG, CTX).nonInteractive, true);
    assert.equal(parseCli(['--yes'], PKG, CTX).nonInteractive, false);
    assert.equal(parseCli(full.filter((a) => a !== '--yes'), PKG, CTX).nonInteractive, false);
    assert.equal(parseCli(['--yes', '--agent', 'pi', '--categories', 'git'], PKG, CTX).nonInteractive, false);
  });

  it('should read the SDK URL and cache dir from the environment', () => {
    const defaults = parseCli([], PKG, CTX);
    assert.equal(defaults.sdkUrl, 'https://example.test/sdk.git');
    assert.equal(defaults.cacheDir, path.join('/home/dev', '.bluecube', 'cache', 'sources'));
    const custom = parseCli([], PKG, { ...CTX, env: { BLUECUBE_SDK_URL: 'file:///sdk', BLUECUBE_CACHE_DIR: '/c' } });
    assert.equal(custom.sdkUrl, 'file:///sdk');
    assert.equal(custom.cacheDir, '/c');
  });
});

describe('exit table', () => {
  it('should keep the documented exit codes', () => {
    assert.deepEqual({ ...EXIT }, { OK: 0, DEPLOY_FAILED: 1, PREFLIGHT: 2, UNSUPPORTED_HARNESS: 3, CANCELLED: 130 });
  });
});

describe('exit mapping', () => {
  function deps({ exec, which = fakeWhich(['uv', 'git', 'claude']), prompt = fakePrompt(), env = {} } = {}) {
    const log = collectLog();
    const logError = collectLog();
    return { exec: exec ?? fakeExec(), which, prompt, env, platform: 'linux', cwd: '/w', homedir: '/h', log, logError, pkg: PKG };
  }

  it('should return 0 for --help and --version', async () => {
    const d = deps();
    assert.equal(await main(['--help'], d), EXIT.OK);
    assert.equal(await main(['--version'], d), EXIT.OK);
    assert.ok(d.log.lines.includes('9.9.9'));
  });

  it('should map a preflight CliError to 2', async () => {
    const exec = fakeExec((cmd, args) => (args[0] === 'ls-remote' ? { code: 128, stderr: 'denied' } : {}));
    const d = deps({ exec });
    assert.equal(await main(['--yes'], d), EXIT.PREFLIGHT);
    assert.match(d.logError.lines.join('\n'), /gh auth login/);
  });

  it('should map an unsupported --agent to 3', async () => {
    const d = deps({ env: { BLUECUBE_CACHE_DIR: await tmpCache() } });
    d.exec = catalogExec();
    assert.equal(await main(['--agent', 'codex', '--yes'], d), EXIT.UNSUPPORTED_HARNESS);
  });

  it('should map a cancelled prompt to 130', async () => {
    const d = deps({ env: { BLUECUBE_CACHE_DIR: await tmpCache() } });
    d.exec = catalogExec();
    d.prompt = { ...fakePrompt(), select: async () => { throw new CliError(EXIT.CANCELLED, 'Cancelled.'); } };
    assert.equal(await main(['--agent', 'claude-code'], d), EXIT.CANCELLED);
  });

  it('should map a failing deploy to 1', async () => {
    const d = deps({ env: { BLUECUBE_CACHE_DIR: await tmpCache() } });
    d.exec = catalogExec({ deployCode: 1 });
    assert.equal(await main(['--agent', 'claude-code', '-g', '--categories', 'git', '--yes'], d), EXIT.DEPLOY_FAILED);
  });

  it('should map an unexpected error to 1', async () => {
    const d = deps();
    d.exec = async () => { throw new Error('boom'); };
    assert.equal(await main(['--yes'], d), EXIT.DEPLOY_FAILED);
    assert.match(d.logError.lines.join('\n'), /boom/);
  });

  it('should run a full non-interactive install without asking', async () => {
    const d = deps({ env: { BLUECUBE_CACHE_DIR: await tmpCache() } });
    d.exec = catalogExec();
    d.prompt = { confirm: fail, select: fail, groupMultiselect: fail };
    assert.equal(await main(['--agent', 'claude-code', '-g', '--categories', 'git', '--yes'], d), EXIT.OK);
    assert.ok(d.log.lines.includes('Next steps'));
  });
});

async function fail() {
  throw new Error('prompted');
}

async function tmpCache() {
  const fs = await import('node:fs');
  const os = await import('node:os');
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-cli-'));
}

// Fake exec that simulates git (creating the slot on clone) and uv for catalog and deploy.
function catalogExec({ deployCode = 0 } = {}) {
  return fakeExec(async (cmd, args) => {
    const fs = await import('node:fs');
    if (cmd === 'git' && args[0] === 'clone') {
      fs.mkdirSync(path.join(args[2], '.git'), { recursive: true });
    }
    if (cmd === 'git' && args[0] === 'rev-parse') return { stdout: 'a'.repeat(40) };
    if (cmd === 'uv' && args.includes('--list-categories')) {
      const fixture = new URL('./fixtures/catalog-claude-code.json', import.meta.url);
      return { stdout: fs.readFileSync(fixture, 'utf8') };
    }
    if (cmd === 'uv') return { code: deployCode };
    return {};
  });
}
