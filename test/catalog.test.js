import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { EXIT } from '../src/cli.js';
import { readCatalog } from '../src/catalog.js';
import { fakeExec } from './helpers.js';

const FIXTURE = fs.readFileSync(new URL('./fixtures/catalog-claude-code.json', import.meta.url), 'utf8');

describe('readCatalog', () => {
  it('should run deploy.py --list-categories in the slot and parse the result', async () => {
    const exec = fakeExec(() => ({ stdout: FIXTURE }));
    const catalog = await readCatalog({ exec, root: '/slot', agent: 'claude-code', ref: 'v1' });
    assert.equal(catalog.schemaVersion, 1);
    assert.ok(catalog.categories.length > 0);
    assert.deepEqual(exec.calls[0], {
      cmd: 'uv',
      args: ['run', 'sdk/deploy.py', '--list-categories', '--json', '--agent', 'claude-code'],
      opts: { cwd: '/slot', timeoutMs: 180000 },
    });
  });

  it('should explain an SDK ref that predates the catalog', async () => {
    const exec = fakeExec(() => ({ code: 2, stderr: 'deploy.py: error: unrecognized arguments: --list-categories --json' }));
    await assert.rejects(
      readCatalog({ exec, root: '/slot', agent: 'pi', ref: 'v0.5.0' }),
      (err) => err.code === EXIT.PREFLIGHT && /predates the category catalog/.test(err.message) && /v0\.5\.0/.test(err.message),
    );
  });

  it('should reject a schema version it does not know', async () => {
    const exec = fakeExec(() => ({ stdout: JSON.stringify({ ...JSON.parse(FIXTURE), schemaVersion: 2 }) }));
    await assert.rejects(readCatalog({ exec, root: '/slot' }), (err) => err.code === EXIT.PREFLIGHT && /schemaVersion 2/.test(err.message));
  });

  it('should reject output that is not JSON', async () => {
    const exec = fakeExec(() => ({ stdout: 'Installed 34 packages\n{' }));
    await assert.rejects(readCatalog({ exec, root: '/slot' }), { code: EXIT.PREFLIGHT });
  });
});
