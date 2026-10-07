import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import * as messages from '../src/messages.js';
import {
  aheadPlugins, installedPluginNames, planMigration, planPluginCommands, runPluginCommands, sourceMatches, wantedSource,
} from '../src/plugins.js';
import { installedPlugins, readRegistration, registryPaths } from '../src/registry.js';
import { collectLog, fakeExec, legacyDeclaration, registryFixture, writeJson } from './helpers.js';

const ADD = ['plugin', 'marketplace', 'add', 'BlueCube-AI/bluecube-coder', '--sparse', '.claude-plugin', 'plugins'];
const LIST = ['plugin', 'marketplace', 'list', '--json'];
const HELP_ADD = ['plugin', 'marketplace', 'add', '--help'];
const HELP_INSTALL = ['plugin', 'install', '--help'];
const MARKETPLACE_UPDATE = ['plugin', 'marketplace', 'update', 'bluecube-coder'];
const GITHUB_URL = 'https://github.com/BlueCube-AI/bluecube-coder.git';
const GITHUB = wantedSource(GITHUB_URL, 'BlueCube-AI/bluecube-coder');
const CLIENT = 'BlueCube-AI/acme-coder';
const CLIENT_URL = 'https://github.com/BlueCube-AI/acme-coder.git';
const CHECKOUT = path.resolve('/src/bluecube-coder');
const LOCAL = wantedSource(pathToFileURL(CHECKOUT).href);
const PINNED = { 'kb-knowledge-graph': '0.7.2', 'bluecube-sdlc': '1.1.1' };
const NO_LEGACY = { declared: null, legacy: null };

// Answers the option checks like a current Claude Code and everything else with `handler`
const currentClaude = (handler = () => ({})) => (cmd, args, opts) =>
  (args.includes('--help') ? { stdout: '  --scope <scope>\n  --sparse <paths...>' } : handler(cmd, args, opts));

const install = (name, scope) => ['plugin', 'install', `${name}@bluecube-coder`, '--scope', scope];
const update = (name, scope) => ['plugin', 'update', `${name}@bluecube-coder`, '--scope', scope];
const fresh = (selected, scope) => planPluginCommands({ selected, scope, wanted: GITHUB, migration: null, installed: [], pinned: PINNED });
const readFiles = (paths) => Object.values(paths).filter(Boolean).map((file) => (fs.existsSync(file) ? fs.readFileSync(file) : null));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * A machine deploy.py registered: both plugins enabled at user scope from copies under the
 * home config directory, and on a repo run bluecube-sdlc also enabled in the repo.
 */
function legacyMachine({ scope = 'homedir', selected = [], wanted = GITHUB } = {}) {
  const { configDir, target } = registryFixture();
  const sdlcDir = path.join(configDir, 'plugins', 'bluecube-sdlc');
  const kbDir = path.join(configDir, 'plugins', 'kb-knowledge-graph');
  for (const dir of [sdlcDir, kbDir]) fs.mkdirSync(dir, { recursive: true });
  const paths = registryPaths({ configDir, target, scope });
  writeJson(paths.homeSettings, {
    extraKnownMarketplaces: { 'bluecube-coder': legacyDeclaration([['bluecube-sdlc', sdlcDir], ['kb-knowledge-graph', kbDir]]) },
    enabledPlugins: { 'bluecube-sdlc@bluecube-coder': true, 'kb-knowledge-graph@bluecube-coder': true },
  });
  writeJson(paths.installed, {
    version: 2,
    plugins: {
      'bluecube-sdlc@bluecube-coder': [{ scope: 'user', installPath: sdlcDir, version: '1.1.1' }],
      'kb-knowledge-graph@bluecube-coder': [{ scope: 'user', installPath: kbDir, version: '0.7.2' }],
    },
  });
  writeJson(paths.known, { cloudflare: { source: { source: 'github', repo: 'cloudflare/skills' } } });
  if (scope === 'repo') {
    writeJson(paths.repoSettings, {
      extraKnownMarketplaces: { 'bluecube-coder': legacyDeclaration([['bluecube-sdlc', path.join(target, 'plugins', 'bluecube-sdlc')]]) },
      enabledPlugins: { 'bluecube-sdlc@bluecube-coder': true },
    });
  }
  const registration = readRegistration({ configDir, target, scope });
  const installed = installedPlugins({ configDir, target, scope });
  const migration = planMigration({ registration, installed, wanted, selected, scope });
  const plan = planPluginCommands({ selected, scope, wanted, migration, installed, pinned: PINNED });
  return { target, paths, wanted, migration, plan, leftoverDirs: [sdlcDir, kbDir] };
}

describe('wantedSource', () => {
  it('should register the GitHub repository with the sparse paths for the GitHub SDK URL', () => {
    assert.deepEqual(GITHUB, { kind: 'github', repo: 'BlueCube-AI/bluecube-coder', addArgs: ADD.slice(3) });
  });

  it('should register the checkout directory for a file:// SDK URL', () => {
    const checkout = path.resolve('/tmp/sdk');
    assert.deepEqual(wantedSource(pathToFileURL(checkout).href), { kind: 'directory', path: checkout, addArgs: [checkout] });
    assert.equal(wantedSource(pathToFileURL(checkout).href, null).kind, 'directory');
  });

  it('should register the chosen client repository with the sparse paths', () => {
    assert.deepEqual(wantedSource(CLIENT_URL, CLIENT), {
      kind: 'github', repo: CLIENT, addArgs: [CLIENT, '--sparse', '.claude-plugin', 'plugins'],
    });
    assert.equal(wantedSource('git@github.com:BlueCube-AI/acme-coder.git', CLIENT).addArgs[0], CLIENT);
  });

  it('should have no source for a URL that names no GitHub repository', () => {
    assert.equal(wantedSource('https://git.example.test/acme-coder.git', null), null);
  });
});

describe('sourceMatches', () => {
  it('should match the GitHub repository as a github or git source', () => {
    assert.equal(sourceMatches({ source: 'github', repo: 'BlueCube-AI/bluecube-coder' }, GITHUB), true);
    assert.equal(sourceMatches({ source: 'git', url: GITHUB_URL, sparsePaths: ['plugins'] }, GITHUB), true);
    assert.equal(sourceMatches({ source: 'git', url: 'https://github.com/BlueCube-AI/bluecube-coder' }, GITHUB), true);
  });

  it('should match the chosen client repository as a github or git source', () => {
    const client = wantedSource(CLIENT_URL, CLIENT);
    assert.equal(sourceMatches({ source: 'github', repo: 'bluecube-ai/ACME-coder' }, client), true);
    assert.equal(sourceMatches({ source: 'git', url: CLIENT_URL }, client), true);
    assert.equal(sourceMatches({ source: 'git', url: 'git@github.com:BlueCube-AI/acme-coder.git' }, client), true);
  });

  it('should not match the SDK repository for a client repository, or the other way round', () => {
    const client = wantedSource(CLIENT_URL, CLIENT);
    assert.equal(sourceMatches({ source: 'github', repo: 'BlueCube-AI/bluecube-coder' }, client), false);
    assert.equal(sourceMatches({ source: 'git', url: GITHUB_URL }, client), false);
    assert.equal(sourceMatches({ source: 'github', repo: CLIENT }, GITHUB), false);
  });

  it('should read a dot in the repository name literally', () => {
    const dotted = wantedSource('https://github.com/BlueCube-AI/acme.coder.git', 'BlueCube-AI/acme.coder');
    assert.equal(sourceMatches({ source: 'git', url: 'https://github.com/BlueCube-AI/acme.coder.git' }, dotted), true);
    assert.equal(sourceMatches({ source: 'git', url: 'https://github.com/BlueCube-AI/acmeXcoder.git' }, dotted), false);
  });

  it('should match a directory source with a trailing slash', () => {
    assert.equal(sourceMatches({ source: 'directory', path: `${CHECKOUT}${path.sep}` }, LOCAL), true);
  });

  it('should reject other repositories, other directories and other kinds', () => {
    assert.equal(sourceMatches({ source: 'github', repo: 'someone/bluecube-coder' }, GITHUB), false);
    assert.equal(sourceMatches({ source: 'git', url: 'https://github.com/BlueCube-AI/bluecube-coder-fork.git' }, GITHUB), false);
    assert.equal(sourceMatches({ source: 'directory', path: CHECKOUT }, GITHUB), false);
    assert.equal(sourceMatches({ source: 'directory', path: path.resolve('/elsewhere') }, LOCAL), false);
    assert.equal(sourceMatches({ source: 'github', repo: 'BlueCube-AI/bluecube-coder' }, LOCAL), false);
  });
});

describe('planMigration', () => {
  const args = { installed: [], wanted: GITHUB, selected: [], scope: 'homedir' };

  it('should keep a matching github registration and an absent one', () => {
    const declared = { source: 'github', repo: 'BlueCube-AI/bluecube-coder' };
    assert.equal(planMigration({ ...args, registration: { declared, legacy: null } }), null);
    assert.equal(planMigration({ ...args, registration: NO_LEGACY }), null);
  });

  it('should carry the legacy plugins at their scopes', () => {
    const legacy = {
      plugins: [{ name: 'bluecube-sdlc', scope: 'user' }, { name: 'kb-knowledge-graph', scope: 'project' }, { name: 'bluecube-sdlc', scope: 'user' }],
      leftoverDirs: ['/h/.claude/plugins/bluecube-sdlc'],
    };
    const migration = planMigration({ ...args, scope: 'repo', registration: { declared: null, legacy } });
    assert.deepEqual(migration, {
      reason: 'legacy',
      carried: [{ name: 'bluecube-sdlc', scope: 'user' }, { name: 'kb-knowledge-graph', scope: 'project' }],
      leftoverDirs: ['/h/.claude/plugins/bluecube-sdlc'],
    });
    const plan = planPluginCommands({ selected: [], scope: 'repo', wanted: GITHUB, migration, installed: [], pinned: PINNED });
    assert.deepEqual(plan.filter((step) => step.kind === 'install').map((step) => step.args), [
      install('bluecube-sdlc', 'user'), install('kb-knowledge-graph', 'user'),
    ]);
  });

  it('should reinstall a plugin carried at user and project scope once, at user scope', () => {
    const legacy = { plugins: [{ name: 'bluecube-sdlc', scope: 'user' }, { name: 'bluecube-sdlc', scope: 'project' }], leftoverDirs: [] };
    const migration = planMigration({ ...args, scope: 'repo', registration: { declared: null, legacy } });
    const plan = planPluginCommands({ selected: ['bluecube-sdlc'], scope: 'repo', wanted: GITHUB, migration, installed: [], pinned: PINNED });
    assert.deepEqual(migration.carried, [{ name: 'bluecube-sdlc', scope: 'user' }, { name: 'bluecube-sdlc', scope: 'project' }]);
    assert.deepEqual(plan.filter((step) => step.kind === 'install').map((step) => step.args), [install('bluecube-sdlc', 'user')]);
  });

  it('should switch a directory registration back to GitHub and carry the installed plugins', () => {
    const installed = [{ name: 'bluecube-sdlc', scope: 'user', version: '1.1.1' }];
    const registration = { declared: { source: 'directory', path: CHECKOUT }, legacy: null };
    assert.deepEqual(planMigration({ ...args, installed, registration, selected: ['kb-knowledge-graph'] }), {
      reason: 'switch',
      carried: [{ name: 'bluecube-sdlc', scope: 'user' }, { name: 'kb-knowledge-graph', scope: 'user' }],
      leftoverDirs: [],
    });
  });

  it('should switch the SDK marketplace to a client repository and carry the installed plugins', () => {
    const installed = [{ name: 'bluecube-sdlc', scope: 'user', version: '1.1.1' }];
    const registration = { declared: { source: 'github', repo: 'BlueCube-AI/bluecube-coder' }, legacy: null };
    const client = wantedSource(CLIENT_URL, CLIENT);
    const migration = planMigration({ ...args, installed, registration, wanted: client });
    assert.deepEqual(migration, { reason: 'switch', carried: [{ name: 'bluecube-sdlc', scope: 'user' }], leftoverDirs: [] });
    const plan = planPluginCommands({ selected: [], scope: 'homedir', wanted: client, migration, installed, pinned: PINNED });
    assert.deepEqual(plan.map((step) => step.args), [
      ['plugin', 'marketplace', 'add', CLIENT, '--sparse', '.claude-plugin', 'plugins'], install('bluecube-sdlc', 'user'),
    ]);
  });

  it('should switch a github registration to the local checkout on a file:// run', () => {
    const registration = { declared: { source: 'git', url: GITHUB_URL }, legacy: null };
    assert.equal(planMigration({ ...args, wanted: LOCAL, registration }).reason, 'switch');
  });

  it('should keep a user scope legacy plugin at user scope when a repo run picks it', () => {
    const legacy = { plugins: [{ name: 'bluecube-sdlc', scope: 'user' }], leftoverDirs: [] };
    const migration = planMigration({ ...args, scope: 'repo', selected: ['bluecube-sdlc'], registration: { declared: null, legacy } });
    const plan = planPluginCommands({ selected: ['bluecube-sdlc'], scope: 'repo', wanted: GITHUB, migration, installed: [], pinned: PINNED });
    assert.deepEqual(plan.filter((step) => step.kind === 'install').map((step) => step.args), [install('bluecube-sdlc', 'user')]);
  });
});

describe('planPluginCommands', () => {
  it('should add the marketplace, then install each plugin at user scope for repo', () => {
    assert.deepEqual(fresh(['kb-knowledge-graph', 'bluecube-sdlc'], 'repo').map((step) => step.args), [
      ADD,
      install('kb-knowledge-graph', 'user'),
      install('bluecube-sdlc', 'user'),
    ]);
  });

  it('should install at user scope for homedir', () => {
    assert.deepEqual(fresh(['bluecube-sdlc'], 'homedir')[1].args, install('bluecube-sdlc', 'user'));
  });

  it('should plan nothing without plugins', () => {
    assert.deepEqual(fresh([], 'repo'), []);
  });

  it('should not reinstall a selected plugin already installed at user scope on a repo run', () => {
    const installed = [{ name: 'bluecube-sdlc', scope: 'user', version: '1.1.1' }];
    assert.deepEqual(planPluginCommands({ selected: ['bluecube-sdlc'], scope: 'repo', wanted: GITHUB, migration: null, installed, pinned: PINNED }), []);
  });

  it('should not reinstall a selected plugin already installed at user scope on a home run', () => {
    const installed = [{ name: 'bluecube-sdlc', scope: 'user', version: '1.1.1' }];
    assert.deepEqual(planPluginCommands({ selected: ['bluecube-sdlc'], scope: 'homedir', wanted: GITHUB, migration: null, installed, pinned: PINNED }), []);
  });

  it('should install at user scope, never at project scope, when the plugin is installed only for this project', () => {
    const installed = [{ name: 'bluecube-sdlc', scope: 'project', version: '1.1.1' }];
    const plan = planPluginCommands({ selected: ['bluecube-sdlc'], scope: 'repo', wanted: GITHUB, migration: null, installed, pinned: PINNED });
    assert.deepEqual(plan.map((step) => step.args), [ADD, install('bluecube-sdlc', 'user')]);
  });

  it('should still update a project scope copy behind the pinned release at its own scope', () => {
    const installed = [{ name: 'bluecube-sdlc', scope: 'project', version: '1.1.0' }];
    const plan = planPluginCommands({ selected: [], scope: 'repo', wanted: GITHUB, migration: null, installed, pinned: PINNED });
    assert.deepEqual(plan.map((step) => step.args), [ADD, MARKETPLACE_UPDATE, update('bluecube-sdlc', 'project')]);
  });

  it('should update the marketplace, then each plugin behind the pinned release at its scope', () => {
    const installed = [{ name: 'bluecube-sdlc', scope: 'user', version: '1.1.0' }];
    const plan = planPluginCommands({ selected: [], scope: 'repo', wanted: GITHUB, migration: null, installed, pinned: PINNED });
    assert.deepEqual(plan.map((step) => step.args), [ADD, MARKETPLACE_UPDATE, update('bluecube-sdlc', 'user')]);
  });

  it('should leave a plugin ahead of the pinned release alone and list it as ahead', () => {
    const installed = [{ name: 'bluecube-sdlc', scope: 'user', version: '1.2.0' }];
    assert.deepEqual(planPluginCommands({ selected: [], scope: 'homedir', wanted: GITHUB, migration: null, installed, pinned: PINNED }), []);
    assert.deepEqual(aheadPlugins({ installed, pinned: PINNED }), [{ name: 'bluecube-sdlc', scope: 'user', version: '1.2.0', pinned: '1.1.1' }]);
  });

  it('should treat a non-numeric version as neither behind nor ahead', () => {
    const installed = [{ name: 'bluecube-sdlc', scope: 'user', version: '8331f9108451' }];
    assert.deepEqual(planPluginCommands({ selected: [], scope: 'homedir', wanted: GITHUB, migration: null, installed, pinned: PINNED }), []);
    assert.deepEqual(aheadPlugins({ installed, pinned: PINNED }), []);
  });

  it('should add the wanted source, then reinstall the carried plugins for a migration', () => {
    const migration = { reason: 'switch', carried: [{ name: 'bluecube-sdlc', scope: 'user' }], leftoverDirs: [] };
    const local = planPluginCommands({ selected: [], scope: 'homedir', wanted: LOCAL, migration, installed: [], pinned: PINNED });
    assert.deepEqual(local.map((step) => step.args), [['plugin', 'marketplace', 'add', CHECKOUT], install('bluecube-sdlc', 'user')]);
    const github = planPluginCommands({ selected: [], scope: 'homedir', wanted: GITHUB, migration, installed: [], pinned: PINNED });
    assert.deepEqual(github[0].args, ADD);
  });
});

describe('installedPluginNames', () => {
  const OK_OUTCOME = { rolledBack: null };
  const results = (statuses) => fresh(['kb-knowledge-graph', 'bluecube-sdlc'], 'repo')
    .map((step, index) => ({ step, status: statuses[index] }));

  it('should drop a plugin whose install failed or was skipped', () => {
    const selected = ['kb-knowledge-graph', 'bluecube-sdlc'];
    assert.deepEqual(installedPluginNames({ selected, migration: null, results: results(['ok', 'failed', 'ok']), outcome: OK_OUTCOME }), ['bluecube-sdlc']);
    assert.deepEqual(installedPluginNames({ selected, migration: null, results: results(['skipped', 'skipped', 'skipped']), outcome: OK_OUTCOME }), []);
  });

  it('should keep a selected plugin that was already installed', () => {
    assert.deepEqual(installedPluginNames({ selected: ['bluecube-sdlc'], migration: null, results: [], outcome: OK_OUTCOME }), ['bluecube-sdlc']);
  });

  it('should list the selected plugins, then the carried ones, once each', () => {
    const migration = { carried: [{ name: 'kb-knowledge-graph', scope: 'user' }, { name: 'bluecube-sdlc', scope: 'project' }] };
    assert.deepEqual(
      installedPluginNames({ selected: ['bluecube-sdlc'], migration, results: [], outcome: OK_OUTCOME }),
      ['bluecube-sdlc', 'kb-knowledge-graph'],
    );
  });

  it('should list nothing after a rollback', () => {
    const outcome = { rolledBack: { command: 'claude plugin install bluecube-sdlc@bluecube-coder --scope user', code: 1 } };
    assert.deepEqual(installedPluginNames({ selected: ['bluecube-sdlc'], migration: null, results: [], outcome }), []);
  });
});

describe('runPluginCommands', () => {
  const plan = fresh(['bluecube-sdlc'], 'repo');

  it('should check the options, list, then add and install in the target', async () => {
    const exec = fakeExec(currentClaude((cmd, args) => (args.includes('list') ? { stdout: '[]' } : {})));
    const { results } = await runPluginCommands({ exec, plan, target: '/w/app', claudePresent: true, log: collectLog() });
    assert.deepEqual(exec.calls.map((c) => c.args), [HELP_ADD, HELP_INSTALL, LIST, ADD, plan[1].args]);
    assert.ok(exec.calls.every((c) => c.cmd === 'claude' && c.opts.cwd === '/w/app'));
    assert.deepEqual(results.map((r) => r.status), ['ok', 'ok']);
  });

  it('should skip the add when the marketplace is already listed', async () => {
    const exec = fakeExec(currentClaude((cmd, args) => (args.includes('list') ? { stdout: JSON.stringify([{ name: 'bluecube-coder' }]) } : {})));
    await runPluginCommands({ exec, plan, target: '/w', claudePresent: true, log: collectLog() });
    assert.deepEqual(exec.calls.map((c) => c.args), [HELP_ADD, HELP_INSTALL, LIST, plan[1].args]);
  });

  it('should mark every step outdated and run nothing when claude lacks an option', async () => {
    const exec = fakeExec((cmd, args) => (args.includes('--help') ? { stdout: 'Options:\n  -h, --help' } : {}));
    const log = collectLog();
    const { results } = await runPluginCommands({ exec, plan, target: '/w', claudePresent: true, log });
    assert.ok(exec.calls.every((c) => c.args.includes('--help')));
    assert.deepEqual(results.map((r) => r.status), ['outdated', 'outdated']);
    assert.deepEqual(log.lines, [messages.pluginClaudeTooOld]);
  });

  it('should mark every step outdated when claude has no plugin command', async () => {
    const exec = fakeExec(() => ({ code: 1, stderr: "error: unknown command 'plugin'" }));
    const { results } = await runPluginCommands({ exec, plan, target: '/w', claudePresent: true, log: collectLog() });
    assert.equal(exec.calls.length, 1);
    assert.deepEqual(results.map((r) => r.status), ['outdated', 'outdated']);
  });

  it('should collect a failure instead of throwing', async () => {
    const exec = fakeExec(currentClaude((cmd, args) => (args[1] === 'install' ? { code: 1 } : { stdout: '[]' })));
    const log = collectLog();
    const { results } = await runPluginCommands({ exec, plan, target: '/w', claudePresent: true, log });
    assert.deepEqual(results.map((r) => r.status), ['ok', 'failed']);
    assert.match(log.lines[0], /Plugin command failed \(exit 1\)/);
  });

  it('should skip every step when claude is absent', async () => {
    const exec = fakeExec();
    const { results } = await runPluginCommands({ exec, plan, target: '/w', claudePresent: false, log: collectLog() });
    assert.equal(exec.calls.length, 0);
    assert.deepEqual(results.map((r) => r.status), ['skipped', 'skipped']);
  });

  it('should print the commands on a dry run', async () => {
    const exec = fakeExec();
    const log = collectLog();
    await runPluginCommands({ exec, plan, dryRun: true, target: '/w', claudePresent: true, log });
    assert.equal(exec.calls.length, 0);
    assert.deepEqual(log.lines, [`claude ${ADD.join(' ')}`, `claude ${plan[1].args.join(' ')}`]);
  });

  it('should collect the plugins a successful update brought to the pinned release', async () => {
    const installed = [{ name: 'bluecube-sdlc', scope: 'user', version: '1.1.0' }];
    const updatePlan = planPluginCommands({ selected: [], scope: 'homedir', wanted: GITHUB, migration: null, installed, pinned: PINNED });
    const exec = fakeExec(currentClaude((cmd, args) => (args.includes('list') ? { stdout: JSON.stringify([{ name: 'bluecube-coder' }]) } : {})));
    const { results, outcome } = await runPluginCommands({ exec, plan: updatePlan, target: '/h', claudePresent: true, log: collectLog() });
    assert.deepEqual(exec.calls.slice(3).map((c) => c.args), [MARKETPLACE_UPDATE, update('bluecube-sdlc', 'user')]);
    assert.deepEqual(results.map((r) => r.status), ['ok', 'ok']);
    assert.deepEqual(outcome.updated, ['bluecube-sdlc']);
  });

  it('should fail the plugin updates without running them when the marketplace update fails', async () => {
    const installed = [{ name: 'bluecube-sdlc', scope: 'user', version: '1.1.0' }];
    const updatePlan = planPluginCommands({ selected: [], scope: 'homedir', wanted: GITHUB, migration: null, installed, pinned: PINNED });
    const exec = fakeExec(currentClaude((cmd, args) => {
      if (args.includes('list')) return { stdout: JSON.stringify([{ name: 'bluecube-coder' }]) };
      return args.includes('update') ? { code: 1 } : {};
    }));
    const { results, outcome } = await runPluginCommands({ exec, plan: updatePlan, target: '/h', claudePresent: true, log: collectLog() });
    assert.deepEqual(exec.calls.slice(3).map((c) => c.args), [MARKETPLACE_UPDATE]);
    assert.deepEqual(results.map((r) => r.status), ['failed', 'failed']);
    assert.deepEqual(outcome.updated, []);
  });
});

describe('runPluginCommands with a migration', () => {
  it('should strip, add, install at the carried scopes, delete the leftovers and report the count', async () => {
    const machine = legacyMachine();
    const declaredAtAdd = [];
    const exec = fakeExec(currentClaude((cmd, args) => {
      if (args[2] === 'add') declaredAtAdd.push('bluecube-coder' in readJson(machine.paths.homeSettings).extraKnownMarketplaces);
      return {};
    }));

    const { results, outcome } = await runPluginCommands({ exec, ...machine, claudePresent: true, log: collectLog() });

    assert.deepEqual(exec.calls.map((c) => c.args), [
      HELP_ADD, HELP_INSTALL, ADD, install('bluecube-sdlc', 'user'), install('kb-knowledge-graph', 'user'),
    ]);
    assert.deepEqual(declaredAtAdd, [false]);
    assert.deepEqual(results.map((r) => r.status), ['ok', 'ok', 'ok']);
    assert.equal(outcome.migrated, 2);
    assert.equal(outcome.localSource, null);
    assert.ok(machine.leftoverDirs.every((dir) => !fs.existsSync(dir)));
    assert.deepEqual(readJson(machine.paths.homeSettings).enabledPlugins, {
      'bluecube-sdlc@bluecube-coder': true, 'kb-knowledge-graph@bluecube-coder': true,
    });
  });

  it('should restore the four registry files byte for byte and keep the leftovers when an install fails', async () => {
    const machine = legacyMachine({ scope: 'repo' });
    const before = readFiles(machine.paths);
    const exec = fakeExec(currentClaude((cmd, args) => {
      // Claude Code records the new marketplace before the install fails.
      if (args[2] === 'add') writeJson(machine.paths.known, { 'bluecube-coder': { source: { source: 'github' } } });
      return args[2] === 'bluecube-sdlc@bluecube-coder' ? { code: 1 } : {};
    }));
    const log = collectLog();

    const { results, outcome } = await runPluginCommands({ exec, ...machine, claudePresent: true, log });

    assert.deepEqual(readFiles(machine.paths), before);
    assert.ok(machine.leftoverDirs.every((dir) => fs.existsSync(dir)));
    const command = `claude ${install('bluecube-sdlc', 'user').join(' ')}`;
    assert.deepEqual(outcome.rolledBack, { command, code: 1 });
    assert.equal(outcome.migrated, null);
    assert.deepEqual(results.map((r) => r.status), ['ok', 'failed', 'rolled-back']);
    assert.deepEqual(log.lines, [messages.pluginFailed(command, 1)]);
  });

  it('should print the detected registration and the commands on a dry run without writing', async () => {
    const machine = legacyMachine();
    const before = readFiles(machine.paths);
    const exec = fakeExec();
    const log = collectLog();

    await runPluginCommands({ exec, ...machine, dryRun: true, claudePresent: true, log });

    assert.equal(exec.calls.length, 0);
    assert.deepEqual(log.lines, [
      'Legacy plugin registration found: bluecube-sdlc (user), kb-knowledge-graph (user); it will be replaced by the GitHub marketplace',
      `claude ${ADD.join(' ')}`,
      `claude ${install('bluecube-sdlc', 'user').join(' ')}`,
      `claude ${install('kb-knowledge-graph', 'user').join(' ')}`,
    ]);
    assert.deepEqual(readFiles(machine.paths), before);
    assert.ok(machine.leftoverDirs.every((dir) => fs.existsSync(dir)));
  });

  for (const [label, claudePresent, exec] of [
    ['absent', false, fakeExec()],
    ['too old', true, fakeExec(() => ({ stdout: 'Options:\n  -h, --help' }))],
  ]) {
    it(`should leave the registry untouched when claude is ${label}`, async () => {
      const machine = legacyMachine();
      const before = readFiles(machine.paths);

      const { results } = await runPluginCommands({ exec, ...machine, claudePresent, log: collectLog() });

      assert.ok(results.every((r) => r.status === (claudePresent ? 'outdated' : 'skipped')));
      assert.deepEqual(readFiles(machine.paths), before);
    });
  }

  it('should report the local checkout after a switch to a file:// source, and nothing after the switch back', async () => {
    const { configDir, target } = registryFixture();
    const paths = registryPaths({ configDir, target, scope: 'homedir' });
    const installed = [{ name: 'bluecube-sdlc', scope: 'user', version: '1.1.1' }];
    writeJson(paths.homeSettings, { extraKnownMarketplaces: { 'bluecube-coder': { source: { source: 'git', url: GITHUB_URL } } } });
    const toLocal = planMigration({ registration: readRegistration({ configDir, target, scope: 'homedir' }), installed, wanted: LOCAL, selected: [], scope: 'homedir' });
    const localPlan = planPluginCommands({ selected: [], scope: 'homedir', wanted: LOCAL, migration: toLocal, installed, pinned: PINNED });

    const local = await runPluginCommands({
      exec: fakeExec(currentClaude()), plan: localPlan, migration: toLocal, paths, wanted: LOCAL, target, claudePresent: true, log: collectLog(),
    });

    assert.deepEqual(local.outcome, { migrated: null, rolledBack: null, localSource: CHECKOUT, updated: [], ahead: [] });

    writeJson(paths.homeSettings, { extraKnownMarketplaces: { 'bluecube-coder': { source: { source: 'directory', path: CHECKOUT } } } });
    const toGithub = planMigration({ registration: readRegistration({ configDir, target, scope: 'homedir' }), installed, wanted: GITHUB, selected: [], scope: 'homedir' });
    const githubPlan = planPluginCommands({ selected: [], scope: 'homedir', wanted: GITHUB, migration: toGithub, installed, pinned: PINNED });

    const github = await runPluginCommands({
      exec: fakeExec(currentClaude()), plan: githubPlan, migration: toGithub, paths, wanted: GITHUB, target, claudePresent: true, log: collectLog(),
    });

    assert.equal(toGithub.reason, 'switch');
    assert.deepEqual(github.outcome, { migrated: null, rolledBack: null, localSource: null, updated: [], ahead: [] });
  });
});
