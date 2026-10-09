import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { buildDeployArgs, runDeploy } from '../src/deploy.js';
import * as messages from '../src/messages.js';
import { projectOnlyCategories } from '../src/picker.js';
import { planPluginCommands, wantedSource } from '../src/plugins.js';
import { installedBlocks, nextSteps, printSummary } from '../src/report.js';
import { collectLog, fakeExec } from './helpers.js';

const CLAUDE = { name: 'claude-code', displayName: 'Claude Code', configDir: '.claude', homedirPath: '~/.claude' };
const PROJECT_ONLY = projectOnlyCategories(JSON.parse(
  fs.readFileSync(new URL('./fixtures/catalog-claude-code-1.1.0.json', import.meta.url), 'utf8'),
));
const NOT_AVAILABLE = 'Not available here: Project Memory, Status Line, Notifications & TTS, Session Logger, Damage Control. '
  + 'Run npx @bluecube-ai/coder inside a project to add them.';
const GITHUB = wantedSource('https://github.com/BlueCube-AI/bluecube-coder.git', 'BlueCube-AI/bluecube-coder');
const freshPlan = (selected, scope) => planPluginCommands({
  selected, scope, wanted: GITHUB, migration: null, installed: [], pinned: {},
});

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
    const plan = freshPlan(['bluecube-sdlc'], 'repo');
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

  it('should print the hooks line after repo installs only', () => {
    assert.deepEqual(nextSteps({ agent: CLAUDE, scope: 'homedir', categories: ['notification'], pluginResults: [] }), [
      'Start a new Claude Code session to load the new commands',
    ]);
    assert.equal(nextSteps({ agent: CLAUDE, scope: 'repo', categories: ['git'], pluginResults: [] }).length, 1);
  });

  it('should name the project-only entries right after the session line on a home run', () => {
    const lines = nextSteps({ agent: CLAUDE, scope: 'homedir', categories: ['git'], pluginResults: [], projectOnly: PROJECT_ONLY });
    assert.deepEqual(lines, ['Start a new Claude Code session to load the new commands', NOT_AVAILABLE]);
  });

  it('should not name the project-only entries on a repo run or without any', () => {
    const repo = nextSteps({ agent: CLAUDE, scope: 'repo', categories: ['git'], pluginResults: [], projectOnly: PROJECT_ONLY });
    const none = nextSteps({ agent: CLAUDE, scope: 'homedir', categories: ['git'], pluginResults: [], projectOnly: [] });
    assert.ok(![...repo, ...none].includes(NOT_AVAILABLE));
  });

  it('should ask for a Claude Code update before the outdated plugin commands', () => {
    const plan = freshPlan(['bluecube-sdlc'], 'repo');
    const lines = nextSteps({
      agent: CLAUDE,
      scope: 'repo',
      categories: ['git'],
      pluginResults: plan.map((step) => ({ step, status: 'outdated' })),
    });
    assert.deepEqual(lines.slice(1), [
      messages.nextStepUpdateClaude,
      'Run by hand: claude plugin marketplace add BlueCube-AI/bluecube-coder --sparse .claude-plugin plugins --scope project',
      'Run by hand: claude plugin install bluecube-sdlc@bluecube-coder --scope project',
    ]);
  });

  it('should list the plugin outcomes after the session line in the documented order', () => {
    const outcome = {
      migrated: 2,
      rolledBack: { command: 'claude plugin install bluecube-sdlc@bluecube-coder --scope user', code: 1 },
      localSource: '/src/bluecube-coder',
      updated: ['bluecube-sdlc', 'kb-knowledge-graph'],
      ahead: [{ name: 'bluecube-sdlc', scope: 'user', version: '1.2.0', pinned: '1.1.1' }],
    };
    const lines = nextSteps({ agent: CLAUDE, scope: 'repo', categories: ['damage_control'], pluginResults: [], outcome });
    assert.deepEqual(lines, [
      'Start a new Claude Code session to load the new commands',
      'Migrated 2 plugins from a local checkout to the GitHub marketplace',
      'Plugin migration rolled back, plugins unchanged: claude plugin install bluecube-sdlc@bluecube-coder --scope user exited with code 1',
      'Plugins load from the local checkout at /src/bluecube-coder; this machine is off the pinned release',
      'Updated to the pinned release: bluecube-sdlc, kb-knowledge-graph',
      'Ahead of the pinned release, left as is: bluecube-sdlc 1.2.0 (pinned 1.1.1)',
      'Review the hooks under .claude/settings.json before you trust them',
    ]);
  });

  it('should add no outcome line for an empty outcome', () => {
    const empty = { migrated: null, rolledBack: null, localSource: null, updated: [], ahead: [] };
    assert.deepEqual(nextSteps({ agent: CLAUDE, scope: 'repo', categories: ['git'], pluginResults: [], outcome: empty }), [
      'Start a new Claude Code session to load the new commands',
    ]);
  });

  it('should name a single migrated plugin in the singular', () => {
    const lines = nextSteps({ agent: CLAUDE, scope: 'repo', categories: [], pluginResults: [], outcome: { migrated: 1 } });
    assert.equal(lines[1], 'Migrated 1 plugin from a local checkout to the GitHub marketplace');
  });

  it('should print no by-hand line after a rolled-back migration', () => {
    const plan = freshPlan(['bluecube-sdlc', 'kb-knowledge-graph'], 'homedir');
    const command = 'claude plugin install bluecube-sdlc@bluecube-coder --scope user';
    const lines = nextSteps({
      agent: CLAUDE,
      scope: 'homedir',
      categories: [],
      pluginResults: [{ step: plan[0], status: 'ok' }, { step: plan[1], status: 'failed', code: 1 }, { step: plan[2], status: 'rolled-back' }],
      outcome: { rolledBack: { command, code: 1 } },
    });
    assert.ok(!lines.some((line) => line.startsWith('Run by hand')));
  });

  it('should ask for an installer rerun instead of by-hand commands while a marketplace move is pending', () => {
    const plan = freshPlan(['bluecube-sdlc'], 'homedir');
    for (const status of ['skipped', 'outdated']) {
      const lines = nextSteps({
        agent: CLAUDE,
        scope: 'homedir',
        categories: [],
        pluginResults: plan.map((step) => ({ step, status })),
        outcome: { migrationPending: true },
      });
      assert.deepEqual(lines.slice(1), [messages.migrationPending], status);
    }
  });

  it('should render under a Next steps heading', () => {
    const log = collectLog();
    printSummary([], ['a', 'b'], log);
    assert.deepEqual(log.lines, ['', 'Next steps', '  - a', '  - b']);
  });
});

describe('installed summary', () => {
  const summary = (args) => {
    const log = collectLog();
    printSummary(installedBlocks({ agent: CLAUDE, target: '/w', targetGiven: false, ...args }), ['a'], log);
    return log.lines;
  };

  it('should list categories, then plugins, under this project on a repo run', () => {
    assert.deepEqual(summary({ scope: 'repo', categoryLabels: ['Git Commands'], pluginNames: ['bluecube-sdlc'] }), [
      '',
      `Installed for this project (${path.join('/w', '.claude')}):`,
      '  - Git Commands',
      '  - bluecube-sdlc',
      '',
      'Next steps',
      '  - a',
    ]);
  });

  it('should list categories, then plugins, in one block on a home run', () => {
    assert.deepEqual(summary({ scope: 'homedir', target: '/h', categoryLabels: ['Git Commands'], pluginNames: ['bluecube-sdlc'] }), [
      '',
      'Installed for every project (~/.claude):',
      '  - Git Commands',
      '  - bluecube-sdlc',
      '',
      'Next steps',
      '  - a',
    ]);
  });

  it('should name the --target folder on a home run given one', () => {
    const blocks = installedBlocks({ scope: 'homedir', agent: CLAUDE, target: '/t', targetGiven: true, categoryLabels: ['Git Commands'], pluginNames: [] });
    assert.deepEqual(blocks.map((block) => block.heading), [`Installed for every project (${path.join('/t', '.claude')}):`]);
  });

  it('should leave out an empty block, and print only Next steps when nothing was installed', () => {
    assert.ok(!summary({ scope: 'repo', categoryLabels: ['Git Commands'], pluginNames: [] }).some((line) => line.startsWith('Installed for every')));
    assert.deepEqual(summary({ scope: 'repo', categoryLabels: [], pluginNames: [] }), ['', 'Next steps', '  - a']);
    assert.deepEqual(summary({ scope: 'homedir', categoryLabels: [], pluginNames: [] }), ['', 'Next steps', '  - a']);
  });
});
