import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planPluginCommands, runPluginCommands } from '../src/plugins.js';
import { collectLog, fakeExec } from './helpers.js';

const ADD = ['plugin', 'marketplace', 'add', 'BlueCube-AI/bluecube-coder', '--sparse', '.claude-plugin', 'plugins'];
const LIST = ['plugin', 'marketplace', 'list', '--json'];

describe('planPluginCommands', () => {
  it('should add the marketplace, then install each plugin at project scope for repo', () => {
    const plan = planPluginCommands({ selected: ['kb-knowledge-graph', 'bluecube-sdlc'], scope: 'repo' });
    assert.deepEqual(plan.map((step) => step.args), [
      ADD,
      ['plugin', 'install', 'kb-knowledge-graph@bluecube-coder', '--scope', 'project'],
      ['plugin', 'install', 'bluecube-sdlc@bluecube-coder', '--scope', 'project'],
    ]);
  });

  it('should install at user scope for homedir', () => {
    const plan = planPluginCommands({ selected: ['bluecube-sdlc'], scope: 'homedir' });
    assert.deepEqual(plan[1].args, ['plugin', 'install', 'bluecube-sdlc@bluecube-coder', '--scope', 'user']);
  });

  it('should plan nothing without plugins', () => {
    assert.deepEqual(planPluginCommands({ selected: [], scope: 'repo' }), []);
  });
});

describe('runPluginCommands', () => {
  const plan = planPluginCommands({ selected: ['bluecube-sdlc'], scope: 'repo' });

  it('should list first, then add and install in the target', async () => {
    const exec = fakeExec((cmd, args) => (args.includes('list') ? { stdout: '[]' } : {}));
    const results = await runPluginCommands({ exec, plan, target: '/w/app', claudePresent: true, log: collectLog() });
    assert.deepEqual(exec.calls.map((c) => c.args), [LIST, ADD, plan[1].args]);
    assert.ok(exec.calls.every((c) => c.cmd === 'claude' && c.opts.cwd === '/w/app'));
    assert.deepEqual(results.map((r) => r.status), ['ok', 'ok']);
  });

  it('should skip the add when the marketplace is already listed', async () => {
    const exec = fakeExec((cmd, args) => (args.includes('list') ? { stdout: JSON.stringify([{ name: 'bluecube-coder' }]) } : {}));
    await runPluginCommands({ exec, plan, target: '/w', claudePresent: true, log: collectLog() });
    assert.deepEqual(exec.calls.map((c) => c.args), [LIST, plan[1].args]);
  });

  it('should collect a failure instead of throwing', async () => {
    const exec = fakeExec((cmd, args) => (args[1] === 'install' ? { code: 1 } : { stdout: '[]' }));
    const log = collectLog();
    const results = await runPluginCommands({ exec, plan, target: '/w', claudePresent: true, log });
    assert.deepEqual(results.map((r) => r.status), ['ok', 'failed']);
    assert.match(log.lines[0], /Plugin command failed \(exit 1\)/);
  });

  it('should skip every step when claude is absent', async () => {
    const exec = fakeExec();
    const results = await runPluginCommands({ exec, plan, target: '/w', claudePresent: false, log: collectLog() });
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
});
