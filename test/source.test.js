import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { EXIT } from '../src/cli.js';
import { run } from '../src/exec.js';
import { cacheSlot, resolveSource } from '../src/source.js';
import { collectLog } from './helpers.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('resolveSource', () => {
  let tmp;
  let url;
  let tagSha;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-source-'));
    const work = path.join(tmp, 'work');
    const bare = path.join(tmp, 'sdk.git');
    fs.mkdirSync(work);
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'config', 'user.email', 'test@example.test');
    git(work, 'config', 'user.name', 'test');
    git(work, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(work, 'README.md'), 'sdk\n');
    git(work, 'add', 'README.md');
    git(work, 'commit', '-q', '-m', 'initial');
    git(work, 'tag', 'v1.0.0');
    tagSha = git(work, 'rev-parse', 'HEAD');
    git(tmp, 'clone', '-q', '--bare', work, bare);
    url = pathToFileURL(bare).href;
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function spyExec() {
    const calls = [];
    const exec = (cmd, args, opts) => {
      calls.push(args[0]);
      return run(cmd, args, opts);
    };
    exec.calls = calls;
    return exec;
  }

  it('should name the slot after the first 16 hex of sha256(url)', () => {
    const expected = createHash('sha256').update('https://x.test/a.git').digest('hex').slice(0, 16);
    assert.equal(cacheSlot('/cache', 'https://x.test/a.git'), path.join('/cache', expected));
  });

  it('should clone, then fetch and reuse the slot at the same ref', async () => {
    const cacheDir = path.join(tmp, 'cache');
    const log = collectLog();

    const first = spyExec();
    const resolved = await resolveSource({ exec: first, cacheDir, url, ref: 'v1.0.0', log });
    assert.equal(resolved.revision, tagSha);
    assert.equal(resolved.root, cacheSlot(cacheDir, url));
    assert.ok(first.calls.includes('clone'));
    assert.ok(!first.calls.includes('fetch'));
    assert.ok(log.lines.includes(`SDK v1.0.0 at ${tagSha.slice(0, 12)}`));

    const record = JSON.parse(fs.readFileSync(path.join(resolved.root, 'source.json'), 'utf8'));
    assert.deepEqual(Object.keys(record).sort(), ['ref', 'resolved_at', 'revision', 'url']);
    assert.equal(record.revision, tagSha);
    assert.equal(git(resolved.root, 'rev-parse', 'HEAD'), tagSha);

    const second = spyExec();
    const again = await resolveSource({ exec: second, cacheDir, url, ref: 'v1.0.0', log });
    assert.equal(again.revision, tagSha);
    assert.ok(second.calls.includes('fetch'));
    assert.ok(!second.calls.includes('clone'));
  });

  it('should resolve a branch and a full commit', async () => {
    const cacheDir = path.join(tmp, 'cache');
    assert.equal((await resolveSource({ exec: run, cacheDir, url, ref: 'main', log: () => {} })).revision, tagSha);
    assert.equal((await resolveSource({ exec: run, cacheDir, url, ref: tagSha, log: () => {} })).revision, tagSha);
  });

  it('should throw exit 2 for an unknown ref', async () => {
    const cacheDir = path.join(tmp, 'cache');
    await assert.rejects(
      resolveSource({ exec: run, cacheDir, url, ref: 'no-such-ref', log: () => {} }),
      (err) => err.code === EXIT.PREFLIGHT && /no-such-ref/.test(err.message),
    );
  });

  it('should re-clone a damaged slot under --yes', async () => {
    const cacheDir = path.join(tmp, 'cache-broken');
    const slot = cacheSlot(cacheDir, url);
    fs.mkdirSync(slot, { recursive: true });
    fs.writeFileSync(path.join(slot, 'junk'), 'x');
    const exec = spyExec();
    const resolved = await resolveSource({ exec, cacheDir, url, ref: 'v1.0.0', log: () => {}, yes: true });
    assert.equal(resolved.revision, tagSha);
    assert.ok(exec.calls.includes('clone'));
    assert.ok(!fs.existsSync(path.join(slot, 'junk')));
  });

  it('should refuse to delete a damaged slot when declined', async () => {
    const cacheDir = path.join(tmp, 'cache-declined');
    fs.mkdirSync(cacheSlot(cacheDir, url), { recursive: true });
    await assert.rejects(
      resolveSource({ exec: run, cacheDir, url, ref: 'v1.0.0', log: () => {}, confirm: async () => false }),
      { code: EXIT.PREFLIGHT },
    );
  });
});
