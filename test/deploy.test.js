import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDeployArgs, runDeploy } from '../src/deploy.js';
import { planPluginCommands } from '../src/plugins.js';
import { nextSteps, printSummary } from '../src/report.js';
import { collectLog, fakeExec } from './helpers.js';

const CLAUDE = { name: 'claude-code', displayName: 'Claude Code', configDir: '.claude', homedirPath: '~/.claude' };

describe('buildDeployArgs', () => {
  it('should build the repo deploy argv with the target', () => {
    assert.deepEqual(
      buildDeployArgs({ scope: 'repo', agent: 'pi', categories: ['git', 'context'], target: '/w/app', targetGiven: false }),
      ['run', 'sdk/deploy.py', '--non-interactive', '--mode', 'repo', '--agent', 'pi', '--categories', 'git,context', '--target', '/w/app'],
    );
  });

  it('should leave the homedir target to deploy.py unless --target was given', () => {
    const args = buildDeployArgs({ scope: 'homedir', agent: 'claude-code', categories: ['git'], target: '/h', targetGiven: false });
    assert.ok(!args.includes('--target'));
    const given = buildDeployArgs({ scope: 'homedir', agent: 'claude-code', categories: ['git'], target: '/h', targetGiven: true });
    assert.deepEqual(given.slice(-2), ['--target', '/h']);
  });
});

describe('runDeploy', () => {
  const args = ['run', 'sdk/deploy.py'];

  for (const code of [0, 1]) {
    it(`should pass exit code ${code} through`, async () => {
      const exec = fakeExec(() => ({ code }));
      assert.equal(await runDeploy({ exec, root: '/slot', args, dryRun: false, log: collectLog() }), code);
      assert.deepEqual(exec.calls[0], { cmd: 'uv', args, opts: { cwd: '/slot', stdio: 'inherit' } });
    });
  }

  it('should print the command and run nothing on a dry run', async () => {
    const exec = fakeExec();
    const log = collectLog();
    assert.equal(await runDeploy({ exec, root: '/slot', args, dryRun: true, log }), 0);
    assert.equal(exec.calls.length, 0);
    assert.deepEqual(log.lines, ['uv run sdk/deploy.py']);
  });
});

describe('nextSteps', () => {
  it('should list the session, hooks and pending plugin lines', () => {
    const plan = planPluginCommands({ selected: ['bluecube-sdlc'], scope: 'repo' });
    const lines = nextSteps({
      agent: CLAUDE,
      scope: 'repo',
      categories: ['git', 'damage_control'],
      pluginResults: [{ step: plan[0], status: 'ok' }, { step: plan[1], status: 'skipped' }],
    });
    assert.deepEqual(lines, [
      'Start a new Claude Code session to load the new commands',
      'Review the hooks under .claude/settings.json before you trust them',
      'Run by hand: claude plugin install bluecube-sdlc@bluecube-coder --scope project',
    ]);
  });

  it('should point at the home config for a homedir install and skip hooks when none were installed', () => {
    assert.deepEqual(
      nextSteps({ agent: CLAUDE, scope: 'homedir', categories: ['notification'], pluginResults: [] })[1],
      'Review the hooks under ~/.claude/settings.json before you trust them',
    );
    assert.equal(nextSteps({ agent: CLAUDE, scope: 'repo', categories: ['git'], pluginResults: [] }).length, 1);
  });

  it('should ask for a Claude Code update before the outdated plugin commands', () => {
    const plan = planPluginCommands({ selected: ['bluecube-sdlc'], scope: 'repo' });
    const lines = nextSteps({
      agent: CLAUDE,
      scope: 'repo',
      categories: ['git'],
      pluginResults: plan.map((step) => ({ step, status: 'outdated' })),
    });
    assert.deepEqual(lines.slice(1), [
      'Update Claude Code with `claude update`, then run the plugin commands below',
      'Run by hand: claude plugin marketplace add BlueCube-AI/bluecube-coder --sparse .claude-plugin plugins',
      'Run by hand: claude plugin install bluecube-sdlc@bluecube-coder --scope project',
    ]);
  });

  it('should render under a Next steps heading', () => {
    const log = collectLog();
    printSummary(['a', 'b'], log);
    assert.deepEqual(log.lines, ['', 'Next steps', '  - a', '  - b']);
  });
});
