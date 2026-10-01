import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXIT } from '../src/cli.js';
import {
  HIDDEN_GROUP, buildHarnessOptions, buildOptions, chooseCategories, chooseHarness, chooseScope,
  confirmRepoTarget, readMarketplace,
} from '../src/picker.js';
import { collectLog, fakeExec, fakePrompt } from './helpers.js';

const CATALOG = JSON.parse(fs.readFileSync(new URL('./fixtures/catalog-claude-code.json', import.meta.url), 'utf8'));
const MARKETPLACE = {
  name: 'bluecube-coder',
  plugins: [{ name: 'kb-knowledge-graph', description: 'KB' }, { name: 'bluecube-sdlc', description: 'SDLC' }],
};
const ALL_DETECTED = [
  { name: 'claude-code', binary: 'claude', path: '/bin/claude' },
  { name: 'codex', binary: 'codex', path: '/bin/codex' },
  { name: 'pi', binary: 'pi', path: '/bin/pi' },
];

describe('chooseHarness', () => {
  it('should render a detected harness missing from the catalog as disabled with the unsupported hint', () => {
    const options = buildHarnessOptions({ detected: ALL_DETECTED, agents: CATALOG.agents, ref: 'v0.6.1' });
    const codex = options.find((option) => option.value === 'codex');
    assert.equal(codex.disabled, true);
    assert.match(codex.hint, /not supported by SDK/);
    assert.equal(options.find((option) => option.value === 'pi').disabled, false);
  });

  it('should badge an agent the catalog marks experimental', () => {
    const agents = [...CATALOG.agents, { name: 'codex', displayName: 'Codex', experimental: true }];
    const codex = buildHarnessOptions({ detected: ALL_DETECTED, agents, ref: 'v1' }).find((o) => o.value === 'codex');
    assert.equal(codex.disabled, false);
    assert.equal(codex.label, 'Codex (experimental)');
  });

  it('should exit 3 for --agent codex', async () => {
    await assert.rejects(
      chooseHarness({ detected: ALL_DETECTED, agents: CATALOG.agents, prompt: fakePrompt(), requested: 'codex', ref: 'v1', log: collectLog() }),
      (err) => err.code === EXIT.UNSUPPORTED_HARNESS && /not supported by SDK/.test(err.message),
    );
  });

  it('should skip the prompt when one supported harness is detected', async () => {
    const prompt = fakePrompt();
    const agent = await chooseHarness({
      detected: ALL_DETECTED.slice(0, 2), agents: CATALOG.agents, prompt, ref: 'v1', log: collectLog(),
    });
    assert.equal(agent.name, 'claude-code');
    assert.equal(prompt.asked.length, 0);
  });

  it('should ask when several supported harnesses are detected', async () => {
    const prompt = fakePrompt({ select: 'pi' });
    const agent = await chooseHarness({ detected: ALL_DETECTED, agents: CATALOG.agents, prompt, ref: 'v1', log: collectLog() });
    assert.equal(agent.name, 'pi');
    assert.equal(prompt.asked[0].options.length, 3);
  });

  it('should exit 2 when nothing is detected', async () => {
    await assert.rejects(
      chooseHarness({ detected: [], agents: CATALOG.agents, prompt: fakePrompt(), ref: 'v1', log: collectLog() }),
      { code: EXIT.PREFLIGHT },
    );
  });
});

describe('chooseScope', () => {
  it('should skip the prompt when the scope was given', async () => {
    const prompt = fakePrompt();
    assert.equal(await chooseScope({ options: { scope: 'homedir' }, prompt }), 'homedir');
    assert.equal(prompt.asked.length, 0);
  });

  it('should offer repo first with the cwd hint', async () => {
    const prompt = fakePrompt({ select: 'repo' });
    await chooseScope({ options: { scope: null, cwd: '/work/app' }, prompt });
    assert.equal(prompt.asked[0].options[0].value, 'repo');
    assert.equal(prompt.asked[0].options[0].hint, 'current directory: /work/app');
  });
});

describe('confirmRepoTarget', () => {
  it('should not ask inside a git work tree', async () => {
    const prompt = fakePrompt();
    await confirmRepoTarget({ exec: fakeExec(() => ({ stdout: 'true\n' })), target: os.tmpdir(), prompt, log: collectLog() });
    assert.equal(prompt.asked.length, 0);
  });

  it('should warn and ask outside a git work tree', async () => {
    const log = collectLog();
    await assert.rejects(
      confirmRepoTarget({ exec: fakeExec(() => ({ code: 128 })), target: os.tmpdir(), prompt: fakePrompt({ confirm: false }), log }),
      { code: EXIT.CANCELLED },
    );
    assert.match(log.lines[0], /not a git work tree/);
  });

  it('should warn but not ask under --yes', async () => {
    const prompt = fakePrompt();
    const log = collectLog();
    await confirmRepoTarget({ exec: fakeExec(), target: path.join(os.tmpdir(), 'bc-missing-target'), prompt, yes: true, log });
    assert.equal(prompt.asked.length, 0);
    assert.equal(log.lines.length, 1);
  });
});

describe('buildOptions', () => {
  it('should group by first appearance, keep catalog order and pre-select defaults', () => {
    const options = buildOptions(CATALOG, 'repo', null);
    const expected = CATALOG.categories.filter((cat) => cat.scope.includes('repo'));
    assert.deepEqual(options.map((o) => o.value), expected.map((cat) => cat.id));
    assert.deepEqual(options.filter((o) => o.selected).map((o) => o.value), expected.filter((c) => c.default).map((c) => c.id));
    const groups = [...new Set(options.map((o) => o.group))];
    assert.equal(groups[0], 'Foundation');
  });

  it('should drop categories outside the scope', () => {
    assert.ok(!buildOptions(CATALOG, 'repo', null).some((o) => o.value === 'adw'));
  });

  it('should hide the BlueCube Marketplace group', () => {
    const catalog = {
      ...CATALOG,
      categories: [
        ...CATALOG.categories,
        { id: 'bluecube_sdlc_plugin', group: HIDDEN_GROUP, label: 'SDLC', desc: '', scope: ['homedir'], default: false, experimental: false },
      ],
    };
    assert.ok(!buildOptions(catalog, 'homedir', null).some((o) => o.group === HIDDEN_GROUP));
  });

  it('should append plugin entries for claude-code only, not pre-selected', () => {
    const options = buildOptions(CATALOG, 'repo', MARKETPLACE);
    const plugins = options.filter((o) => o.group === 'Claude Code plugins');
    assert.deepEqual(plugins.map((o) => o.value), ['plugin:kb-knowledge-graph', 'plugin:bluecube-sdlc']);
    assert.ok(plugins.every((o) => !o.selected));
    assert.deepEqual(options.slice(-2), plugins);
    assert.ok(!buildOptions({ ...CATALOG, agent: 'pi' }, 'repo', MARKETPLACE).some((o) => o.value.startsWith('plugin:')));
  });

  it('should badge experimental categories once', () => {
    const agentTeam = buildOptions(CATALOG, 'repo', null).find((o) => o.value === 'agent_team');
    assert.equal(agentTeam.label, 'Agent Teams (Experimental)');
    const flagged = buildOptions({ ...CATALOG, categories: [{ ...CATALOG.categories[0], experimental: true }] }, 'repo', null);
    assert.equal(flagged[0].label, 'Project Memory (experimental)');
  });
});

describe('chooseCategories', () => {
  const options = buildOptions(CATALOG, 'repo', MARKETPLACE);

  it('should accept known --categories ids including plugins', async () => {
    const selected = await chooseCategories({ options, prompt: fakePrompt(), requested: ['git', 'plugin:bluecube-sdlc'], scope: 'repo', agent: 'claude-code' });
    assert.deepEqual(selected, ['git', 'plugin:bluecube-sdlc']);
  });

  it('should exit 2 for an unknown category id', async () => {
    await assert.rejects(
      chooseCategories({ options, prompt: fakePrompt(), requested: ['git', 'nope'], scope: 'repo', agent: 'claude-code' }),
      (err) => err.code === EXIT.PREFLIGHT && /nope/.test(err.message),
    );
  });

  it('should show one grouped multi-select with the defaults pre-selected', async () => {
    const prompt = fakePrompt({ groupMultiselect: [['git']] });
    assert.deepEqual(await chooseCategories({ options, prompt, scope: 'repo', agent: 'claude-code' }), ['git']);
    assert.equal(prompt.asked.length, 1);
    assert.deepEqual(Object.keys(prompt.asked[0].options)[0], 'Foundation');
    assert.ok(prompt.asked[0].initialValues.includes('memory_init'));
  });

  it('should ask once more on an empty selection, then cancel', async () => {
    const prompt = fakePrompt({ groupMultiselect: [[], []] });
    await assert.rejects(chooseCategories({ options, prompt, scope: 'repo', agent: 'claude-code' }), { code: EXIT.CANCELLED });
    assert.equal(prompt.asked.length, 2);
  });

  it('should exit 0 with a message when nothing is available', async () => {
    await assert.rejects(
      chooseCategories({ options: [], prompt: fakePrompt(), scope: 'homedir', agent: 'opencode' }),
      (err) => err.code === EXIT.OK && err.message === 'no homedir categories for opencode',
    );
  });
});

describe('readMarketplace', () => {
  it('should read the committed marketplace from the SDK root', () => {
    const marketplace = readMarketplace(fileURLToPath(new URL('./fixtures/sdk-root/', import.meta.url)));
    assert.equal(marketplace.name, 'bluecube-coder');
    assert.deepEqual(marketplace.plugins.map((p) => p.name), ['kb-knowledge-graph', 'bluecube-sdlc']);
  });

  it('should return null when the file is missing', () => {
    assert.equal(readMarketplace(os.tmpdir()), null);
  });
});
