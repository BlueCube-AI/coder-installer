import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXIT } from '../src/cli.js';
import {
  HIDDEN_GROUP, buildHarnessOptions, buildOptions, chooseCategories, chooseHarness, chooseRepository,
  chooseScope, confirmRepoTarget, projectOnlyCategories, readMarketplace,
} from '../src/picker.js';
import { collectLog, fakeExec, fakePrompt } from './helpers.js';

const readFixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const CATALOG = readFixture('catalog-claude-code.json');
const CATALOG_110 = readFixture('catalog-claude-code-1.1.0.json');
const CLAUDE = CATALOG.agents.find((agent) => agent.name === 'claude-code');
const PROJECT_ONLY_IDS = ['memory_init', 'status_line', 'notification', 'session_logger', 'damage_control'];
const NOT_AVAILABLE = 'Not available here: Project Memory, Status Line, Notifications & TTS, Session Logger, Damage Control. '
  + 'Run npx @bluecube-ai/coder inside a project to add them.';
const MARKETPLACE = {
  name: 'bluecube-coder',
  plugins: [{ name: 'kb-knowledge-graph', description: 'KB' }, { name: 'bluecube-sdlc', description: 'SDLC' }],
};
const ALL_DETECTED = [
  { name: 'claude-code', binary: 'claude', path: '/bin/claude' },
  { name: 'codex', binary: 'codex', path: '/bin/codex' },
  { name: 'pi', binary: 'pi', path: '/bin/pi' },
];

describe('chooseRepository', () => {
  const SDK_URL = 'https://github.com/BlueCube-AI/bluecube-coder.git';

  it('should offer the client repository first and the full SDK for BlueCube staff', async () => {
    const prompt = fakePrompt({ select: 'sdk' });
    assert.equal(await chooseRepository({ prompt, sdkRepo: SDK_URL }), SDK_URL);
    assert.deepEqual(prompt.asked[0].options, [
      { value: 'client', label: 'My client repository' },
      { value: 'sdk', label: 'Full BlueCube SDK (BlueCube staff)' },
    ]);
    assert.equal(prompt.asked[0].initialValue, 'client');
    assert.equal(prompt.asked.length, 1);
  });

  it('should ask for the client repository as owner/name and trim it', async () => {
    const prompt = fakePrompt({ select: 'client', text: ' BlueCube-AI/acme-coder ' });
    assert.equal(await chooseRepository({ prompt, sdkRepo: SDK_URL }), 'BlueCube-AI/acme-coder');
    assert.equal(prompt.asked[1].kind, 'text');
    assert.equal(prompt.asked[1].validate('BlueCube-AI/acme-coder'), undefined);
    assert.match(prompt.asked[1].validate('acme-coder'), /owner\/name/);
  });
});

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

describe('projectOnlyCategories', () => {
  it('should list the repo-only entries of the SDK 1.1.0 catalog in catalog order', () => {
    assert.deepEqual(projectOnlyCategories(CATALOG_110), [
      { id: 'memory_init', label: 'Project Memory' },
      { id: 'status_line', label: 'Status Line' },
      { id: 'notification', label: 'Notifications & TTS' },
      { id: 'session_logger', label: 'Session Logger' },
      { id: 'damage_control', label: 'Damage Control' },
    ]);
  });

  it('should list nothing for the SDK 1.0.0 catalog and never list a disabled entry', () => {
    assert.deepEqual(projectOnlyCategories(CATALOG), []);
    assert.ok(!projectOnlyCategories(CATALOG_110).some(({ id }) => id === 'adw'));
  });

  it('should skip the BlueCube Marketplace group', () => {
    const hidden = { id: 'bluecube_sdlc_plugin', group: HIDDEN_GROUP, label: 'SDLC', scope: ['repo'] };
    assert.deepEqual(projectOnlyCategories({ ...CATALOG, categories: [hidden] }), []);
  });
});

describe('chooseScope', () => {
  const PROJECT_ONLY = projectOnlyCategories(CATALOG_110);

  it('should skip the prompt when the scope was given', async () => {
    const prompt = fakePrompt();
    assert.equal(await chooseScope({ options: { scope: 'homedir' }, prompt, agent: CLAUDE }), 'homedir');
    assert.equal(prompt.asked.length, 0);
  });

  it('should offer repo first and name the folder each choice writes to', async () => {
    const prompt = fakePrompt({ select: 'repo' });
    await chooseScope({ options: { scope: null, cwd: '/work/app', target: null }, prompt, agent: CLAUDE, projectOnly: PROJECT_ONLY });
    const [repo, home] = prompt.asked[0].options;
    assert.deepEqual(repo, { value: 'repo', label: `Only this project (${path.join('/work/app', '.claude')})` });
    assert.equal(home.value, 'homedir');
    assert.equal(home.label, 'Every project on this machine (~/.claude)');
    assert.equal(prompt.asked[0].initialValue, 'repo');
  });

  it('should name the project-only entries in the home hint', async () => {
    const prompt = fakePrompt({ select: 'homedir' });
    await chooseScope({ options: { scope: null, cwd: '/work/app', target: null }, prompt, agent: CLAUDE, projectOnly: PROJECT_ONLY });
    assert.equal(prompt.asked[0].options[1].hint, NOT_AVAILABLE);
  });

  it('should leave the home hint out without project-only entries', async () => {
    const prompt = fakePrompt({ select: 'homedir' });
    await chooseScope({ options: { scope: null, cwd: '/work/app', target: null }, prompt, agent: CLAUDE, projectOnly: [] });
    assert.ok(!('hint' in prompt.asked[0].options[1]));
  });

  it('should name the --target folder in both labels', async () => {
    const prompt = fakePrompt({ select: 'repo' });
    await chooseScope({ options: { scope: null, cwd: '/work/app', target: '/t' }, prompt, agent: CLAUDE });
    assert.deepEqual(prompt.asked[0].options.map((o) => o.label), [
      `Only this project (${path.join('/t', '.claude')})`,
      `Every project on this machine (${path.join('/t', '.claude')})`,
    ]);
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

  it('should pre-select every category and plugin of a client package', () => {
    const catalog = { ...CATALOG_110, categories: CATALOG_110.categories.map((cat) => ({ ...cat, default: false })) };
    for (const scope of ['repo', 'homedir']) {
      const options = buildOptions(catalog, scope, MARKETPLACE, { selectAll: true });
      assert.ok(options.some((o) => o.value.startsWith('plugin:')));
      assert.ok(options.every((o) => o.selected), scope);
    }
  });

  it('should tag the project-only entries of a repo run', () => {
    const options = buildOptions(CATALOG_110, 'repo', MARKETPLACE);
    const label = (id) => options.find((o) => o.value === id).label;
    assert.equal(label('damage_control'), 'Damage Control (this project only)');
    assert.equal(label('git'), 'Git Commands');
    assert.ok(options.filter((o) => o.value.startsWith('plugin:')).every((o) => o.group === 'Claude Code plugins'));
  });

  it('should leave the project-only entries out of a home run without a tag', () => {
    const options = buildOptions(CATALOG_110, 'homedir', MARKETPLACE);
    assert.ok(!options.some((o) => PROJECT_ONLY_IDS.includes(o.value)));
    assert.ok(!options.some((o) => o.label.includes('this project only')));
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

  it('should start with every option of a client package selected', async () => {
    const all = buildOptions(CATALOG_110, 'repo', MARKETPLACE, { selectAll: true });
    const prompt = fakePrompt({ groupMultiselect: [['git']] });
    await chooseCategories({ options: all, prompt, scope: 'repo', agent: 'claude-code' });
    assert.deepEqual(prompt.asked[0].initialValues, all.map((option) => option.value));
    assert.ok(prompt.asked[0].initialValues.includes('plugin:bluecube-sdlc'));
  });

  it('should ask once more on an empty selection, then cancel', async () => {
    const prompt = fakePrompt({ groupMultiselect: [[], []] });
    await assert.rejects(chooseCategories({ options, prompt, scope: 'repo', agent: 'claude-code' }), { code: EXIT.CANCELLED });
    assert.equal(prompt.asked.length, 2);
  });

  describe('when a home run asks for a project-only id', () => {
    const home = buildOptions(CATALOG_110, 'homedir', MARKETPLACE);
    const projectOnly = projectOnlyCategories(CATALOG_110);
    const ask = (requested, scopeFlag) => chooseCategories({
      options: home, prompt: fakePrompt(), requested, scope: 'homedir', agent: 'claude-code', projectOnly, scopeFlag,
    });

    it('should refuse with exit 2 and name the id and the command to run inside the project', async () => {
      await assert.rejects(ask(['git', 'damage_control'], '-g'), (err) => {
        assert.equal(err.code, EXIT.PREFLIGHT);
        assert.equal(err.message, "Damage Control (damage_control) can't be installed with -g. It only works inside one project.\n"
          + 'Run this inside the project instead:\n\n  npx @bluecube-ai/coder --categories damage_control\n\nNothing was installed.');
        return true;
      });
    });

    it('should name several refused ids in one sentence and one command', async () => {
      await assert.rejects(ask(['status_line', 'git', 'damage_control'], '-g'), (err) => {
        assert.ok(err.message.startsWith(
          "Status Line (status_line) and Damage Control (damage_control) can't be installed with -g. They only work inside one project.",
        ));
        assert.ok(err.message.includes('  npx @bluecube-ai/coder --categories status_line,damage_control\n'));
        return true;
      });
    });

    it('should name the flag that chose the home scope, or the prompt choice', async () => {
      await assert.rejects(ask(['damage_control'], '--scope homedir'), /can't be installed with --scope homedir\. It only works/);
      await assert.rejects(ask(['damage_control'], null), /can't be installed for every project\. It only works/);
    });

    it('should report an unknown id first and never call a refused id unknown', async () => {
      await assert.rejects(ask(['nope', 'damage_control'], '-g'), (err) => {
        assert.equal(err.code, EXIT.PREFLIGHT);
        assert.ok(err.message.startsWith('Unknown category id(s) for claude-code in homedir scope: nope\n'));
        return true;
      });
    });

    it('should accept a project-only id on a repo run', async () => {
      const repo = buildOptions(CATALOG_110, 'repo', MARKETPLACE);
      const selected = await chooseCategories({
        options: repo, prompt: fakePrompt(), requested: ['damage_control'], scope: 'repo', agent: 'claude-code', projectOnly, scopeFlag: null,
      });
      assert.deepEqual(selected, ['damage_control']);
    });
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

  it('should return the pinned version of each plugin', () => {
    const marketplace = readMarketplace(fileURLToPath(new URL('./fixtures/sdk-root/', import.meta.url)));
    assert.deepEqual(marketplace.plugins.map((p) => p.version), ['0.7.2', '1.1.1']);
  });

  it('should return null when the file is missing', () => {
    assert.equal(readMarketplace(os.tmpdir()), null);
  });
});
