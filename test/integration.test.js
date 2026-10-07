// End-to-end run against the real deploy.py. Needs uv, git and an SDK URL:
//   BLUECUBE_INSTALLER_INTEGRATION=1 BLUECUBE_SDK_URL=file:///path/to/your/bluecube-coder npm run test:integration
// The URL must point at a git repository whose committed HEAD has `deploy.py --list-categories`.
//
// Client package mode runs instead of the full SDK suite when BLUECUBE_INSTALLER_CLIENT_PACKAGE=1:
//   BLUECUBE_INSTALLER_INTEGRATION=1 BLUECUBE_INSTALLER_CLIENT_PACKAGE=1 BLUECUBE_SDK_URL=file:///path/to/pkg npm run test:integration
// The URL must point at a git repository built from the fixture client sample-a: on branch main,
// a first commit with entries context, git and release_notes, plugin bluecube-sdlc and revision 1,
// which branch `previous` points at, then a second commit (main) that republishes the same SDK
// version without release_notes as revision 2.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as messages from '../src/messages.js';
import { cacheSlot } from '../src/source.js';

const CLIENT_PACKAGE = process.env.BLUECUBE_INSTALLER_CLIENT_PACKAGE === '1';
const ENABLED = process.env.BLUECUBE_INSTALLER_INTEGRATION === '1' && !CLIENT_PACKAGE;
const BIN = fileURLToPath(new URL('../bin/coder.js', import.meta.url));
const TIMEOUT_MS = 600000;

// One file each new SDK 1.1.0 entry writes, relative to <project>/.claude.
const NEW_ENTRIES = [
  ['skill_creator', 'skills/skill-creator/SKILL.md'],
  ['plugin_creator', 'skills/plugin-creator/SKILL.md'],
  ['git_activity_analysis', 'skills/git-activity-analysis/SKILL.md'],
  ['release_notes', 'skills/release-notes/SKILL.md'],
  ['bluecube_docx_style', 'skills/bluecube-docx-style/SKILL.md'],
  ['bluecube_pptx_style', 'skills/bluecube-pptx-style/SKILL.md'],
  ['bluecube_xlsx_style', 'skills/bluecube-xlsx-style/SKILL.md'],
  ['prompt_agent_builder', 'agents/meta-agent.md'],
  ['expert_builder', 'agents/expert-creator.md'],
  ['memory_updater', 'commands/memory/improve.md'],
];

const fullSdkSkip = CLIENT_PACKAGE ? 'client package mode' : 'set BLUECUBE_INSTALLER_INTEGRATION=1';

describe('installer against the real SDK', { skip: !ENABLED && fullSdkSkip }, () => {
  let tmp;
  let cacheDir;
  let target;
  const url = process.env.BLUECUBE_SDK_URL;

  const newProject = (name) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: dir });
    return dir;
  };

  before(() => {
    assert.ok(url, 'BLUECUBE_SDK_URL is required');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-integration-'));
    cacheDir = path.join(tmp, 'cache');
    target = newProject('project');
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const run = (args) => spawnSync(
    process.execPath,
    [BIN, '--agent', 'claude-code', '--ref', 'HEAD', '--yes', ...args],
    {
      // A run must never read or update the developer's real plugin registry.
      env: { ...process.env, BLUECUBE_CACHE_DIR: cacheDir, BLUECUBE_SDK_URL: url, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config') },
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
    },
  );
  const install = (dir, ...extra) => run(['--scope', 'repo', '--target', dir, ...extra]);
  const installHome = (home, ...extra) => run(['-g', '--target', home, ...extra]);
  const sourceLine = (stdout) => stdout.split('\n').find((line) => line.startsWith('Source:')) ?? '';
  const allowList = (home) => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).permissions.allow;

  it('should install git commands, then reuse the cache on a second run', () => {
    const first = install(target, '--categories', 'git');
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.ok(fs.existsSync(path.join(target, '.claude', 'commands', 'git', 'commit.md')));
    assert.ok(fs.existsSync(path.join(cacheSlot(cacheDir, url), 'source.json')));
    assert.match(first.stdout, /Installed for this project/);
    assert.match(first.stdout, /Next steps/);
    assert.match(sourceLine(first.stdout), /clone/);

    const second = install(target, '--categories', 'git');
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.match(sourceLine(second.stdout), /fetch/);
    assert.doesNotMatch(sourceLine(second.stdout), /clone/);
  });

  it('should exit 2 for an unknown category id', () => {
    const result = install(target, '--categories', 'nope');
    assert.equal(result.status, 2, result.stderr + result.stdout);
    assert.match(result.stderr, /Unknown category id\(s\) for claude-code in repo scope: nope/);
  });

  for (const [id, file] of NEW_ENTRIES) {
    it(`should install ${id} on its own`, () => {
      const project = newProject(id);
      const result = install(project, '--categories', id);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.ok(fs.existsSync(path.join(project, '.claude', file)), `${file} is missing`);
    });
  }

  it('should update a home install on a second run without duplicating permissions', () => {
    const home = newProject('home-rerun');
    const first = installHome(home, '--categories', 'git');
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const allowed = allowList(home);

    const second = installHome(home, '--categories', 'git');
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.ok(fs.existsSync(path.join(home, '.claude', 'commands', 'git', 'commit.md')));
    // The SDK sorts the list when it merges into existing settings, so only the entries count.
    const allowedAgain = allowList(home);
    assert.deepEqual([...allowedAgain].sort(), [...allowed].sort());
    assert.equal(new Set(allowedAgain).size, allowedAgain.length);
  });

  it('should refuse a project-only id on a home run and write nothing', () => {
    const home = newProject('home-refusal');
    const result = installHome(home, '--categories', 'git,damage_control');
    assert.equal(result.status, 2, result.stderr + result.stdout);
    assert.match(result.stderr, /Damage Control \(damage_control\) can't be installed with -g/);
    assert.ok(!fs.existsSync(path.join(home, '.claude')));
  });
});

// The fixture client and the entry its second publish removes.
const SAMPLE_CLIENT = 'sample-a';
const REMOVED_ENTRY = 'release_notes';
const REMOVED_DIR = path.join('skills', 'release-notes');
// In the full SDK catalog, outside sample-a.
const UNENTITLED_ID = 'memory_init';

describe('installer against a client package', { skip: !CLIENT_PACKAGE && 'set BLUECUBE_INSTALLER_CLIENT_PACKAGE=1' }, () => {
  let tmp;
  let cacheDir;
  const url = process.env.BLUECUBE_SDK_URL;

  const newProject = (name) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: dir });
    return dir;
  };

  before(() => {
    assert.ok(url, 'BLUECUBE_SDK_URL is required');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-client-package-'));
    cacheDir = path.join(tmp, 'cache');
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // A file:// URL keeps the pinned default ref, so every run names the package commit it wants.
  // No run selects a plugin and the plugin registry is a temp directory, so the claude CLI never runs.
  const install = (dir, ref, ids) => spawnSync(
    process.execPath,
    [BIN, '--agent', 'claude-code', '--yes', '--scope', 'repo', '--target', dir, '--ref', ref, '--categories', ids],
    {
      env: { ...process.env, BLUECUBE_CACHE_DIR: cacheDir, BLUECUBE_SDK_URL: url, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config') },
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
    },
  );
  // The slot holds the commit of the last run.
  const fetchedPackage = () => JSON.parse(fs.readFileSync(path.join(cacheSlot(cacheDir, url), 'client-package.json'), 'utf8'));
  const installedManifest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'SDK_MANIFEST.json'), 'utf8'));
  const filesUnder = (dir) => Object.fromEntries(
    fs.readdirSync(dir, { recursive: true })
      .filter((name) => fs.statSync(path.join(dir, name)).isFile())
      .map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]),
  );
  const validIds = (stderr) => (stderr.split('\n').find((line) => line.startsWith('Valid ids: ')) ?? '')
    .slice('Valid ids: '.length).split(', ').filter(Boolean);

  it('should list only the package entries and plugins', () => {
    const result = install(newProject('catalog'), 'previous', 'nope');
    assert.equal(result.status, 2, result.stderr + result.stdout);

    const fetched = fetchedPackage();
    assert.equal(fetched.client, SAMPLE_CLIENT);
    assert.ok(fetched.entries.includes(REMOVED_ENTRY), 'branch previous must hold the first publish');
    const offered = validIds(result.stderr);
    assert.deepEqual(offered.filter((id) => !id.startsWith('plugin:')).sort(), [...fetched.entries].sort());
    assert.deepEqual(offered.filter((id) => id.startsWith('plugin:')).sort(), fetched.plugins.map((name) => `plugin:${name}`).sort());
  });

  it('should exit 2 for an id outside the package and write nothing', () => {
    const project = newProject('unentitled');
    const result = install(project, 'previous', UNENTITLED_ID);
    assert.equal(result.status, 2, result.stderr + result.stdout);
    assert.match(result.stderr, new RegExp(`Unknown category id\\(s\\) for claude-code in repo scope: ${UNENTITLED_ID}`));
    assert.ok(!fs.existsSync(path.join(project, '.claude')));
  });

  it('should install the package entries and record the client package in SDK_MANIFEST.json', () => {
    const project = newProject('entitled');
    const result = install(project, 'previous', 'context,git,release_notes');
    assert.equal(result.status, 0, result.stderr + result.stdout);

    assert.ok(fs.existsSync(path.join(project, '.claude', 'commands', 'git', 'commit.md')));
    assert.ok(fs.existsSync(path.join(project, '.claude', REMOVED_DIR, 'SKILL.md')));
    const fetched = fetchedPackage();
    assert.deepEqual(installedManifest(project).client_package, { client: fetched.client, revision: fetched.revision });
  });

  it('should announce the republished package on a rerun and leave the removed entry in place', () => {
    const project = newProject('rerun');
    const first = install(project, 'previous', 'context,git,release_notes');
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const installed = installedManifest(project);
    const removedFiles = filesUnder(path.join(project, '.claude', REMOVED_DIR));
    assert.ok(Object.keys(removedFiles).length > 0);

    const rerun = install(project, 'main', 'context,git');
    assert.equal(rerun.status, 0, rerun.stderr + rerun.stdout);

    const republished = fetchedPackage();
    assert.ok(!republished.entries.includes(REMOVED_ENTRY), 'main must hold the publish without release_notes');
    assert.ok(rerun.stdout.split('\n').includes(messages.newerPackage(republished, installed)), rerun.stdout);
    assert.deepEqual(filesUnder(path.join(project, '.claude', REMOVED_DIR)), removedFiles);
    assert.equal(installedManifest(project).client_package.revision, republished.revision);
  });
});
