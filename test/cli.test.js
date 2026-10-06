import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { CliError, EXIT, installDir, parseCli } from '../src/cli.js';
import { main } from '../src/index.js';
import {
  collectLog, fakeExec, fakePrompt, fakeWhich, legacyDeclaration, registryFixture, writeJson,
} from './helpers.js';

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

  it('should record the flag that chose the home scope', () => {
    assert.equal(parseCli(['-g'], PKG, CTX).scopeFlag, '-g');
    assert.equal(parseCli(['--scope', 'homedir'], PKG, CTX).scopeFlag, '--scope homedir');
    assert.equal(parseCli(['--scope', 'repo'], PKG, CTX).scopeFlag, null);
    assert.equal(parseCli([], PKG, CTX).scopeFlag, null);
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

describe('installDir', () => {
  const agent = { configDir: '.claude' };

  it('should name the project folder on a repo run', () => {
    assert.equal(installDir({ scope: 'repo', agent, cwd: '/work/app', target: null }), path.join('/work/app', '.claude'));
    assert.equal(installDir({ scope: 'repo', agent, cwd: '/work/app', target: '/t' }), path.join('/t', '.claude'));
  });

  it('should name the home folder on a home run, or the --target folder', () => {
    assert.equal(installDir({ scope: 'homedir', agent, cwd: '/work/app', target: null }), '~/.claude');
    assert.equal(installDir({ scope: 'homedir', agent, cwd: '/work/app', target: '/t' }), path.join('/t', '.claude'));
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
    const heading = d.log.lines.indexOf('Installed for every project (~/.claude):');
    assert.ok(heading !== -1 && heading < d.log.lines.indexOf('Next steps'));
    assert.equal(d.log.lines[heading + 1], '  - Git Commands');
  });

  it('should list what a repo run installed for this project before Next steps', async () => {
    const { configDir } = registryFixture();
    const d = deps({ env: { BLUECUBE_CACHE_DIR: await tmpCache(), CLAUDE_CONFIG_DIR: configDir } });
    d.exec = catalogExec();
    d.prompt = { confirm: fail, select: fail, groupMultiselect: fail };

    assert.equal(await main(['--agent', 'claude-code', '--scope', 'repo', '--categories', 'git', '--yes'], d), EXIT.OK);

    const heading = d.log.lines.indexOf(`Installed for this project (${path.join('/w', '.claude')}):`);
    assert.ok(heading !== -1 && heading < d.log.lines.indexOf('Next steps'));
    assert.equal(d.log.lines[heading + 1], '  - Git Commands');
  });

  it('should refuse a project-only id on a home run before deploying anything', async () => {
    const d = deps({ env: { BLUECUBE_CACHE_DIR: await tmpCache() } });
    d.exec = catalogExec({ fixture: 'catalog-claude-code-1.1.0.json' });

    const code = await main(['--agent', 'claude-code', '-g', '--categories', 'git,damage_control', '--yes'], d);

    assert.equal(code, EXIT.PREFLIGHT);
    assert.match(d.logError.lines.join('\n'), /^Damage Control \(damage_control\) can't be installed with -g\./);
    assert.ok(!d.exec.calls.some((c) => c.args.includes('--non-interactive')));
    assert.ok(!d.exec.calls.some((c) => c.cmd === 'claude'));
  });

  it('should map a rolled-back plugin migration to 1 after printing the report', async () => {
    const { settings, sdlcDir, configDir } = legacyHome();
    const before = fs.readFileSync(settings);
    const d = deps({ env: { BLUECUBE_CACHE_DIR: await tmpCache(), CLAUDE_CONFIG_DIR: configDir } });
    d.exec = catalogExec({ claude: (args) => (args[1] === 'install' ? { code: 1 } : {}) });

    assert.equal(await main(['--agent', 'claude-code', '-g', '--categories', 'git', '--yes'], d), EXIT.DEPLOY_FAILED);

    const rollback = '  - Plugin migration rolled back, plugins unchanged: claude plugin install bluecube-sdlc@bluecube-coder --scope user exited with code 1';
    assert.ok(d.log.lines.indexOf(rollback) > d.log.lines.indexOf('Next steps'));
    assert.deepEqual(fs.readFileSync(settings), before);
    assert.ok(fs.existsSync(sdlcDir));
  });

  it('should leave the plugin registry alone on a pi run', async () => {
    const { settings, configDir } = legacyHome();
    const before = fs.readFileSync(settings);
    const d = deps({ env: { BLUECUBE_CACHE_DIR: await tmpCache(), CLAUDE_CONFIG_DIR: configDir } });
    d.exec = catalogExec();

    assert.equal(await main(['--agent', 'pi', '-g', '--categories', 'git', '--yes'], d), EXIT.OK);

    assert.ok(!d.exec.calls.some((c) => c.cmd === 'claude'));
    assert.ok(!d.log.lines.some((line) => /plugin/i.test(line)));
    assert.deepEqual(fs.readFileSync(settings), before);
  });
});

// A home config directory with bluecube-sdlc enabled at user scope through deploy.py's legacy registration.
function legacyHome() {
  const { configDir } = registryFixture();
  const sdlcDir = path.join(configDir, 'plugins', 'bluecube-sdlc');
  fs.mkdirSync(sdlcDir, { recursive: true });
  const settings = path.join(configDir, 'settings.json');
  writeJson(settings, {
    extraKnownMarketplaces: { 'bluecube-coder': legacyDeclaration([['bluecube-sdlc', sdlcDir]]) },
    enabledPlugins: { 'bluecube-sdlc@bluecube-coder': true },
  });
  return { configDir, settings, sdlcDir };
}

async function fail() {
  throw new Error('prompted');
}

async function tmpCache() {
  const os = await import('node:os');
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-cli-'));
}

// Fake exec that simulates git (creating the slot on clone), uv for catalog and deploy, and a
// current claude CLI whose plugin commands answer with `claude`.
function catalogExec({ deployCode = 0, claude = () => ({}), fixture = 'catalog-claude-code.json' } = {}) {
  return fakeExec(async (cmd, args) => {
    if (cmd === 'claude') return args.includes('--help') ? { stdout: '--scope --sparse' } : claude(args);
    if (cmd === 'git' && args[0] === 'clone') {
      fs.mkdirSync(path.join(args[2], '.git'), { recursive: true });
    }
    if (cmd === 'git' && args[0] === 'rev-parse') return { stdout: 'a'.repeat(40) };
    if (cmd === 'uv' && args.includes('--list-categories')) {
      return { stdout: fs.readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8') };
    }
    if (cmd === 'uv') return { code: deployCode };
    return {};
  });
}
