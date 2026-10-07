// End-to-end run against the real deploy.py. Needs uv, git and an SDK URL:
//   BLUECUBE_INSTALLER_INTEGRATION=1 BLUECUBE_SDK_URL=file:///path/to/your/bluecube-coder npm run test:integration
// The URL must point at a git repository whose committed HEAD has `deploy.py --list-categories`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cacheSlot } from '../src/source.js';

const ENABLED = process.env.BLUECUBE_INSTALLER_INTEGRATION === '1';
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

describe('installer against the real SDK', { skip: !ENABLED && 'set BLUECUBE_INSTALLER_INTEGRATION=1' }, () => {
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
