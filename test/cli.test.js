import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { CliError, EXIT, installDir, parseCli, repoSlugOf } from '../src/cli.js';
import { main } from '../src/index.js';
import * as messages from '../src/messages.js';
import {
  catalogExec, collectLog, fakeExec, fakePrompt, fakeWhich, legacyDeclaration, registryFixture, tmpCache,
  writeJson,
} from './helpers.js';

const PKG = { version: '9.9.9', bluecube: { sdkRepo: 'https://example.test/sdk.git', sdkRef: 'v0.6.1' } };
const CTX = { env: {}, cwd: '/work/project', homedir: '/home/dev' };
const SDK = 'BlueCube-AI/bluecube-coder';
const CLIENT = 'BlueCube-AI/acme-coder';
const CLIENT_URL = 'https://github.com/BlueCube-AI/acme-coder.git';

describe('parseCli', () => {
  it('should default the ref to bluecube.sdkRef for the SDK repository', () => {
    assert.equal(parseCli([SDK], PKG, CTX).ref, 'v0.6.1');
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
    assert.equal(defaults.sdkUrl, null);
    assert.equal(defaults.cacheDir, path.join('/home/dev', '.bluecube', 'cache', 'sources'));
    const custom = parseCli([], PKG, { ...CTX, env: { BLUECUBE_SDK_URL: 'file:///sdk', BLUECUBE_CACHE_DIR: '/c' } });
    assert.equal(custom.sdkUrl, 'file:///sdk');
    assert.equal(custom.cacheDir, '/c');
  });
});

describe('parseCli repository', () => {
  const source = (argv, env = {}) => {
    const { sdkUrl, repoSlug, ref } = parseCli(argv, PKG, { ...CTX, env });
    return { sdkUrl, repoSlug, ref };
  };

  it('should install a client repository given as owner/name from its main branch', () => {
    assert.deepEqual(source([CLIENT]), { sdkUrl: CLIENT_URL, repoSlug: CLIENT, ref: 'main' });
  });

  it('should take the repository from --repo the same way', () => {
    assert.deepEqual(source(['--repo', CLIENT]), { sdkUrl: CLIENT_URL, repoSlug: CLIENT, ref: 'main' });
  });

  it('should keep a git URL as given and read the repository from it', () => {
    assert.deepEqual(source([CLIENT_URL]), { sdkUrl: CLIENT_URL, repoSlug: CLIENT, ref: 'main' });
    const ssh = 'git@github.com:BlueCube-AI/acme-coder.git';
    assert.deepEqual(source(['--repo', ssh]), { sdkUrl: ssh, repoSlug: CLIENT, ref: 'main' });
  });

  it('should keep the pinned ref for the SDK repository', () => {
    assert.deepEqual(source([SDK]), { sdkUrl: 'https://github.com/BlueCube-AI/bluecube-coder.git', repoSlug: SDK, ref: 'v0.6.1' });
    assert.equal(source(['https://github.com/bluecube-ai/bluecube-coder']).ref, 'v0.6.1');
  });

  it('should let --ref win over every default', () => {
    assert.equal(source([CLIENT, '--ref', 'v2']).ref, 'v2');
    assert.equal(source([SDK, '--ref', 'main']).ref, 'main');
    assert.equal(source(['--ref', 'HEAD'], { BLUECUBE_SDK_URL: 'file:///pkg' }).ref, 'HEAD');
  });

  it('should read the client repository from an SSH URL in BLUECUBE_SDK_URL', () => {
    const ssh = 'git@github.com:BlueCube-AI/acme-coder.git';
    assert.deepEqual(source([], { BLUECUBE_SDK_URL: ssh }), { sdkUrl: ssh, repoSlug: CLIENT, ref: 'main' });
  });

  it('should give a file:// URL no repository and the pinned ref', () => {
    assert.deepEqual(source([], { BLUECUBE_SDK_URL: 'file:///pkg' }), { sdkUrl: 'file:///pkg', repoSlug: null, ref: 'v0.6.1' });
  });

  it('should let BLUECUBE_SDK_URL replace the URL of the repository argument', () => {
    assert.deepEqual(source([CLIENT], { BLUECUBE_SDK_URL: 'file:///pkg' }), { sdkUrl: 'file:///pkg', repoSlug: null, ref: 'v0.6.1' });
  });

  it('should give a URL outside GitHub no repository and the pinned ref', () => {
    const url = 'https://git.example.test/acme-coder.git';
    assert.deepEqual(source([url]), { sdkUrl: url, repoSlug: null, ref: 'v0.6.1' });
  });

  it('should leave the repository unknown without an argument, --repo or BLUECUBE_SDK_URL', () => {
    assert.deepEqual(source(['--yes']), { sdkUrl: null, repoSlug: null, ref: null });
  });

  it('should exit 2 for a repository that is neither owner/name nor a git URL', () => {
    assert.throws(() => parseCli(['acme-coder'], PKG, CTX), (err) => {
      assert.equal(err.code, EXIT.PREFLIGHT);
      assert.equal(err.message, messages.repoInvalid('acme-coder'));
      return true;
    });
  });

  it('should exit 2 when the repository is named twice', () => {
    for (const argv of [[CLIENT, SDK], [CLIENT, '--repo', CLIENT]]) {
      assert.throws(() => parseCli(argv, PKG, CTX), { code: EXIT.PREFLIGHT, message: messages.repoConflict });
    }
  });
});

describe('repoSlugOf', () => {
  it('should read owner/name from GitHub HTTPS and SSH URLs, with or without .git', () => {
    assert.equal(repoSlugOf('https://github.com/BlueCube-AI/acme-coder.git'), CLIENT);
    assert.equal(repoSlugOf('https://github.com/BlueCube-AI/acme-coder'), CLIENT);
    assert.equal(repoSlugOf('git@github.com:BlueCube-AI/acme-coder.git'), CLIENT);
    assert.equal(repoSlugOf('git@github.com:BlueCube-AI/acme-coder'), CLIENT);
  });

  it('should return null for any other URL', () => {
    assert.equal(repoSlugOf('file:///src/acme-coder'), null);
    assert.equal(repoSlugOf('https://gitlab.com/BlueCube-AI/acme-coder.git'), null);
    assert.equal(repoSlugOf('https://github.com/BlueCube-AI/acme-coder/tree/main'), null);
  });
});

describe('repository choice', () => {
  function deps({ prompt = fakePrompt(), env = {}, exec = catalogExec() } = {}) {
    return {
      exec, which: fakeWhich(['uv', 'git', 'claude']), prompt, env: { BLUECUBE_CACHE_DIR: tmpCache(), ...env },
      platform: 'linux', cwd: '/w', homedir: '/h', log: collectLog(), logError: collectLog(), pkg: PKG,
    };
  }
  const HOME_GIT = ['--agent', 'claude-code', '-g', '--categories', 'git'];
  const lsRemoteUrl = (exec) => exec.calls.find((c) => c.args[0] === 'ls-remote')?.args[2];
  const resolvedRef = (exec) => exec.calls.find((c) => c.args[0] === 'rev-parse')?.args.at(-1);

  it('should refuse a non-interactive run without a repository, name the command and run nothing', async () => {
    const d = deps();

    const code = await main(['--yes', ...HOME_GIT], d);

    assert.equal(code, EXIT.PREFLIGHT);
    assert.equal(d.logError.lines.join('\n'), messages.repoRequired);
    assert.match(messages.repoRequired, /^  npx @bluecube-ai\/coder <owner\/client-repo>$/m);
    assert.equal(d.exec.calls.length, 0);
    assert.equal(d.prompt.asked.length, 0);
  });

  it('should count BLUECUBE_SDK_URL as a repository in a non-interactive run', async () => {
    const d = deps({ env: { BLUECUBE_SDK_URL: 'file:///pkg' } });
    d.prompt = { confirm: fail, select: fail, text: fail, groupMultiselect: fail };

    assert.equal(await main(['--yes', ...HOME_GIT], d), EXIT.OK);

    assert.equal(lsRemoteUrl(d.exec), 'file:///pkg');
  });

  it('should offer the client repository and the full SDK, then install from the client repository', async () => {
    const prompt = fakePrompt({ select: ['client'], text: CLIENT });
    const d = deps({ prompt });

    assert.equal(await main(HOME_GIT, d), EXIT.OK);

    assert.equal(prompt.asked[0].message, messages.repoPrompt);
    assert.deepEqual(prompt.asked[0].options.map((option) => option.label), ['My client repository', 'Full BlueCube SDK (BlueCube staff)']);
    assert.equal(prompt.asked[1].kind, 'text');
    assert.equal(lsRemoteUrl(d.exec), CLIENT_URL);
    assert.equal(resolvedRef(d.exec), 'origin/main^{commit}');
  });

  it('should accept only owner/name as the client repository', async () => {
    const prompt = fakePrompt({ select: ['client'], text: CLIENT });
    await main(HOME_GIT, deps({ prompt }));
    const { validate } = prompt.asked[1];

    assert.equal(validate(CLIENT), undefined);
    assert.equal(validate(` ${CLIENT} `), undefined);
    for (const value of [undefined, '', 'acme-coder', 'https://github.com/BlueCube-AI/acme-coder', 'a/b/c']) {
      assert.equal(validate(value), messages.repoNameInvalid, String(value));
    }
  });

  it('should install the full SDK at the pinned ref for BlueCube staff', async () => {
    const prompt = fakePrompt({ select: ['sdk'] });
    const d = deps({ prompt });

    assert.equal(await main(HOME_GIT, d), EXIT.OK);

    assert.equal(prompt.asked.length, 1);
    assert.equal(lsRemoteUrl(d.exec), PKG.bluecube.sdkRepo);
    assert.equal(resolvedRef(d.exec), 'origin/v0.6.1^{commit}');
  });

  it('should keep --ref when the repository comes from the prompt', async () => {
    const d = deps({ prompt: fakePrompt({ select: ['client'], text: CLIENT }) });
    assert.equal(await main([...HOME_GIT, '--ref', 'v2'], d), EXIT.OK);
    assert.equal(resolvedRef(d.exec), 'origin/v2^{commit}');
  });

  it('should name the chosen client repository when its account has no access', async () => {
    const stderr = 'remote: Repository not found.';
    const exec = fakeExec((cmd, args) => (args[0] === 'ls-remote' ? { code: 128, stderr } : {}));
    const d = deps({ exec });

    assert.equal(await main([CLIENT, '--yes'], d), EXIT.PREFLIGHT);

    assert.equal(d.logError.lines.join('\n'), messages.gitNoAccess(CLIENT_URL, stderr, CLIENT));
    assert.match(d.logError.lines.join('\n'), /ask BlueCube for read access to BlueCube-AI\/acme-coder\./);
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
    assert.equal(await main([SDK, '--yes'], d), EXIT.PREFLIGHT);
    assert.match(d.logError.lines.join('\n'), /gh auth login/);
  });

  it('should map an unsupported --agent to 3', async () => {
    const d = deps({ env: { BLUECUBE_CACHE_DIR: await tmpCache() } });
    d.exec = catalogExec();
    assert.equal(await main([SDK, '--agent', 'codex', '--yes'], d), EXIT.UNSUPPORTED_HARNESS);
  });

  it('should map a cancelled prompt to 130', async () => {
    const d = deps({ env: { BLUECUBE_CACHE_DIR: await tmpCache() } });
    d.exec = catalogExec();
    d.prompt = { ...fakePrompt(), select: async () => { throw new CliError(EXIT.CANCELLED, 'Cancelled.'); } };
    assert.equal(await main([SDK, '--agent', 'claude-code'], d), EXIT.CANCELLED);
  });

  it('should map a failing deploy to 1', async () => {
    const d = deps({ env: { BLUECUBE_CACHE_DIR: await tmpCache() } });
    d.exec = catalogExec({ deployCode: 1 });
    assert.equal(await main([SDK, '--agent', 'claude-code', '-g', '--categories', 'git', '--yes'], d), EXIT.DEPLOY_FAILED);
  });

  it('should map an unexpected error to 1', async () => {
    const d = deps();
    d.exec = async () => { throw new Error('boom'); };
    assert.equal(await main([SDK, '--yes'], d), EXIT.DEPLOY_FAILED);
    assert.match(d.logError.lines.join('\n'), /boom/);
  });

  it('should run a full non-interactive install without asking', async () => {
    const d = deps({ env: { BLUECUBE_CACHE_DIR: await tmpCache() } });
    d.exec = catalogExec();
    d.prompt = { confirm: fail, select: fail, groupMultiselect: fail };
    assert.equal(await main([SDK, '--agent', 'claude-code', '-g', '--categories', 'git', '--yes'], d), EXIT.OK);
    const heading = d.log.lines.indexOf('Installed for every project (~/.claude):');
    assert.ok(heading !== -1 && heading < d.log.lines.indexOf('Next steps'));
    assert.equal(d.log.lines[heading + 1], '  - Git Commands');
  });

  it('should list what a repo run installed for this project before Next steps', async () => {
    const { configDir } = registryFixture();
    const d = deps({ env: { BLUECUBE_CACHE_DIR: await tmpCache(), CLAUDE_CONFIG_DIR: configDir } });
    d.exec = catalogExec();
    d.prompt = { confirm: fail, select: fail, groupMultiselect: fail };

    assert.equal(await main([SDK, '--agent', 'claude-code', '--scope', 'repo', '--categories', 'git', '--yes'], d), EXIT.OK);

    const heading = d.log.lines.indexOf(`Installed for this project (${path.join('/w', '.claude')}):`);
    assert.ok(heading !== -1 && heading < d.log.lines.indexOf('Next steps'));
    assert.equal(d.log.lines[heading + 1], '  - Git Commands');
  });

  it('should refuse a project-only id on a home run before deploying anything', async () => {
    const d = deps({ env: { BLUECUBE_CACHE_DIR: await tmpCache() } });
    d.exec = catalogExec({ fixture: 'catalog-claude-code-1.1.0.json' });

    const code = await main([SDK, '--agent', 'claude-code', '-g', '--categories', 'git,damage_control', '--yes'], d);

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

    assert.equal(await main([SDK, '--agent', 'claude-code', '-g', '--categories', 'git', '--yes'], d), EXIT.DEPLOY_FAILED);

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

    assert.equal(await main([SDK, '--agent', 'pi', '-g', '--categories', 'git', '--yes'], d), EXIT.OK);

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
