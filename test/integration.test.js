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

describe('installer against the real SDK', { skip: !ENABLED && 'set BLUECUBE_INSTALLER_INTEGRATION=1' }, () => {
  let tmp;
  let cacheDir;
  let target;
  const url = process.env.BLUECUBE_SDK_URL;

  before(() => {
    assert.ok(url, 'BLUECUBE_SDK_URL is required');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-integration-'));
    cacheDir = path.join(tmp, 'cache');
    target = path.join(tmp, 'project');
    fs.mkdirSync(target);
    spawnSync('git', ['init', '-q'], { cwd: target });
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const install = (...extra) => spawnSync(
    process.execPath,
    [BIN, '--agent', 'claude-code', '--scope', 'repo', '--target', target, '--ref', 'HEAD', '--yes', ...extra],
    { env: { ...process.env, BLUECUBE_CACHE_DIR: cacheDir, BLUECUBE_SDK_URL: url }, encoding: 'utf8', timeout: TIMEOUT_MS },
  );
  const sourceLine = (stdout) => stdout.split('\n').find((line) => line.startsWith('Source:')) ?? '';

  it('should install git commands, then reuse the cache on a second run', () => {
    const first = install('--categories', 'git');
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.ok(fs.existsSync(path.join(target, '.claude', 'commands', 'git', 'commit.md')));
    assert.ok(fs.existsSync(path.join(cacheSlot(cacheDir, url), 'source.json')));
    assert.match(first.stdout, /Next steps/);
    assert.match(sourceLine(first.stdout), /clone/);

    const second = install('--categories', 'git');
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.match(sourceLine(second.stdout), /fetch/);
    assert.doesNotMatch(sourceLine(second.stdout), /clone/);
  });

  it('should exit 2 for an unknown category id', () => {
    const result = install('--categories', 'nope');
    assert.equal(result.status, 2, result.stderr + result.stdout);
    assert.match(result.stderr, /Unknown category id\(s\) for claude-code in repo scope: nope/);
  });
});
