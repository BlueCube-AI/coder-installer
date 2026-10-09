import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { EXIT } from '../src/cli.js';
import { main } from '../src/index.js';
import * as messages from '../src/messages.js';
import { isNewer, readClientPackage, readInstalledManifest } from '../src/package.js';
import { catalogExec, collectLog, fakePrompt, fakeWhich, tmpCache, writeJson } from './helpers.js';

const PKG = { version: '9.9.9', bluecube: { sdkRepo: 'https://example.test/sdk.git', sdkRef: 'v0.6.1' } };
const CLIENT = 'BlueCube-AI/acme-coder';

const clientPackage = (sdkVersion, revision) => ({
  schemaVersion: 1,
  client: 'acme',
  name: 'Acme Corp',
  repository: CLIENT,
  sdkVersion,
  revision,
  publishedAt: '2026-10-07T12:00:00Z',
  entries: ['context', 'git'],
  plugins: ['bluecube-sdlc'],
});

const manifest = (sdkVersion, revision) => ({
  sdk_version: sdkVersion,
  deployed_at: '2026-10-01T09:00:00Z',
  categories: ['context', 'git'],
  deployment_type: 'repo',
  agent: 'claude-code',
  manifest_version: '1.0',
  ...(revision === undefined ? {} : { client_package: { client: 'acme', revision } }),
});

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bc-package-'));

describe('readClientPackage', () => {
  it('should read client-package.json from the slot', () => {
    const slot = tmpDir();
    writeJson(path.join(slot, 'client-package.json'), clientPackage('1.2.0', 1));
    assert.deepEqual(readClientPackage(slot), clientPackage('1.2.0', 1));
  });

  it('should return null for the full SDK and for a file that is not a JSON object', () => {
    const slot = tmpDir();
    assert.equal(readClientPackage(slot), null);
    fs.writeFileSync(path.join(slot, 'client-package.json'), '{ not json');
    assert.equal(readClientPackage(slot), null);
    fs.writeFileSync(path.join(slot, 'client-package.json'), '[1]');
    assert.equal(readClientPackage(slot), null);
  });
});

describe('readInstalledManifest', () => {
  it('should read SDK_MANIFEST.json from the agent config directory', () => {
    const configDir = path.join(tmpDir(), '.claude');
    writeJson(path.join(configDir, 'SDK_MANIFEST.json'), manifest('1.1.0', 3));
    assert.deepEqual(readInstalledManifest(configDir), manifest('1.1.0', 3));
  });

  it('should return null before the first install', () => {
    assert.equal(readInstalledManifest(path.join(tmpDir(), '.claude')), null);
  });
});

describe('isNewer', () => {
  it('should find a higher SDK version newer whatever the revisions', () => {
    assert.equal(isNewer(clientPackage('1.2.0', 1), manifest('1.1.0', 3)), true);
    assert.equal(isNewer(clientPackage('1.10.0', 1), manifest('1.9.0', 1)), true);
  });

  it('should find a higher revision of the same SDK version newer', () => {
    assert.equal(isNewer(clientPackage('1.1.0', 4), manifest('1.1.0', 3)), true);
  });

  it('should find an equal or older package not newer', () => {
    assert.equal(isNewer(clientPackage('1.1.0', 3), manifest('1.1.0', 3)), false);
    assert.equal(isNewer(clientPackage('1.1.0', 2), manifest('1.1.0', 3)), false);
    assert.equal(isNewer(clientPackage('1.0.0', 9), manifest('1.1.0', 1)), false);
  });

  it('should find nothing newer without a manifest, a client_package block or a client package', () => {
    assert.equal(isNewer(clientPackage('1.2.0', 1), null), false);
    assert.equal(isNewer(clientPackage('1.2.0', 1), manifest('1.1.0')), false);
    assert.equal(isNewer(null, manifest('1.1.0', 3)), false);
  });

  it('should find nothing newer when a version is not dotted numbers', () => {
    assert.equal(isNewer(clientPackage('1.2.0-rc.1', 1), manifest('1.1.0', 3)), false);
  });
});

describe('newerPackage', () => {
  it('should name both versions and revisions', () => {
    assert.equal(
      messages.newerPackage(clientPackage('1.2.0', 1), manifest('1.1.0', 3)),
      'A newer version of your BlueCube Coder package is available: 1.2.0 (revision 1). This install has 1.1.0 (revision 3).',
    );
  });
});

describe('a client package run', () => {
  const NOTICE = /^A newer version of your BlueCube Coder package is available/;

  function deps({ fetched, prompt = fakePrompt(), homedir = tmpDir() }) {
    return {
      exec: catalogExec({ slotFiles: fetched ? { 'client-package.json': fetched } : {} }),
      which: fakeWhich(['uv', 'git', 'claude']),
      prompt,
      env: { BLUECUBE_CACHE_DIR: tmpCache() },
      platform: 'linux',
      cwd: '/w',
      homedir,
      log: collectLog(),
      logError: collectLog(),
      pkg: PKG,
    };
  }

  // Repo run into a fresh project that holds `installed` as its SDK_MANIFEST.json, if given.
  async function repoRun({ fetched, installed }) {
    const project = tmpDir();
    if (installed) writeJson(path.join(project, '.claude', 'SDK_MANIFEST.json'), installed);
    const d = deps({ fetched });
    const argv = [CLIENT, '--agent', 'claude-code', '--scope', 'repo', '--target', project, '--categories', 'git', '--yes'];
    const code = await main(argv, d);
    assert.equal(code, EXIT.OK, d.logError.lines.join('\n'));
    return d.log.lines;
  }

  it('should say that a newer package is available, then install it', async () => {
    const lines = await repoRun({ fetched: clientPackage('1.2.0', 1), installed: manifest('1.1.0', 3) });
    const notice = lines.indexOf(messages.newerPackage(clientPackage('1.2.0', 1), manifest('1.1.0', 3)));
    assert.ok(notice !== -1);
    assert.ok(notice < lines.findIndex((line) => line.startsWith('Installed for this project')));
  });

  it('should print no notice for the same package, a first install or a full SDK install', async () => {
    for (const installed of [manifest('1.2.0', 1), null, manifest('1.1.0')]) {
      const lines = await repoRun({ fetched: clientPackage('1.2.0', 1), installed });
      assert.ok(!lines.some((line) => NOTICE.test(line)), JSON.stringify(installed));
    }
  });

  it('should print no notice when the fetched source is the full SDK', async () => {
    const lines = await repoRun({ fetched: null, installed: manifest('1.1.0', 3) });
    assert.ok(!lines.some((line) => NOTICE.test(line)));
  });

  it('should read the installed manifest from the home config directory on a home run', async () => {
    const homedir = tmpDir();
    writeJson(path.join(homedir, '.claude', 'SDK_MANIFEST.json'), manifest('1.1.0', 3));
    const d = deps({ fetched: clientPackage('1.1.0', 4), homedir });

    assert.equal(await main([CLIENT, '--agent', 'claude-code', '-g', '--categories', 'git', '--yes'], d), EXIT.OK);

    assert.ok(d.log.lines.includes(messages.newerPackage(clientPackage('1.1.0', 4), manifest('1.1.0', 3))));
  });

  // A marketplace in the slot, so the picker offers plugins too.
  const withMarketplace = (d) => {
    d.exec = catalogExec({
      slotFiles: {
        'client-package.json': clientPackage('1.2.0', 1),
        '.claude-plugin/marketplace.json': { name: 'bluecube-coder', plugins: [{ name: 'bluecube-sdlc', version: '1.1.1' }] },
      },
    });
    return d;
  };
  const pickerOf = (prompt) => {
    const picker = prompt.asked.find((question) => question.kind === 'groupMultiselect');
    return { offered: Object.values(picker.options).flat().map((option) => option.value), initial: picker.initialValues };
  };

  it('should open the picker of a home run with only the plugins of the package selected', async () => {
    const prompt = fakePrompt({ groupMultiselect: [['git']] });
    const d = withMarketplace(deps({ fetched: clientPackage('1.2.0', 1), prompt }));

    assert.equal(await main([CLIENT, '--agent', 'claude-code', '-g'], d), EXIT.OK);

    const { offered, initial } = pickerOf(prompt);
    assert.ok(offered.includes('git'));
    assert.deepEqual(initial, ['plugin:bluecube-sdlc']);
  });

  it('should open the picker of a repo run with every category but notifications selected and no plugin', async () => {
    const prompt = fakePrompt({ groupMultiselect: [['git']], confirm: true });
    const d = withMarketplace(deps({ fetched: clientPackage('1.2.0', 1), prompt }));

    assert.equal(await main([CLIENT, '--agent', 'claude-code', '--scope', 'repo', '--target', tmpDir()], d), EXIT.OK);

    const { offered, initial } = pickerOf(prompt);
    assert.ok(offered.includes('plugin:bluecube-sdlc') && offered.includes('notification'));
    const expected = offered.filter((id) => !id.startsWith('plugin:') && id !== 'notification');
    assert.deepEqual([...initial].sort(), expected.sort());
  });

  describe('on a machine whose plugins come from the full SDK', () => {
    // bluecube-gauntlet is installed from the SDK marketplace; the package offers only bluecube-sdlc.
    function sdkMachine(homedir) {
      const configDir = path.join(homedir, '.claude');
      writeJson(path.join(configDir, 'settings.json'), {
        extraKnownMarketplaces: { 'bluecube-coder': { source: { source: 'github', repo: 'BlueCube-AI/bluecube-coder' } } },
      });
      writeJson(path.join(configDir, 'plugins', 'installed_plugins.json'), {
        version: 2,
        plugins: {
          'bluecube-sdlc@bluecube-coder': [{ scope: 'user', version: '1.1.1' }],
          'bluecube-gauntlet@bluecube-coder': [{ scope: 'user', version: '1.0.1' }],
        },
      });
      const files = ['settings.json', path.join('plugins', 'installed_plugins.json')].map((file) => path.join(configDir, file));
      return () => files.map((file) => fs.readFileSync(file, 'utf8'));
    }
    const claudeCalls = (d) => d.exec.calls.filter((call) => call.cmd === 'claude');

    it('should leave the plugins alone on a run that picks none', async () => {
      const homedir = tmpDir();
      const registry = sdkMachine(homedir);
      const before = registry();
      const d = withMarketplace(deps({ fetched: clientPackage('1.2.0', 1), homedir }));

      const argv = [CLIENT, '--agent', 'claude-code', '--scope', 'repo', '--target', tmpDir(), '--categories', 'git', '--yes'];
      assert.equal(await main(argv, d), EXIT.OK);

      assert.deepEqual(claudeCalls(d), []);
      assert.deepEqual(registry(), before);
    });

    it('should name the plugin the package lacks and change nothing on a run that picks a plugin', async () => {
      const homedir = tmpDir();
      const registry = sdkMachine(homedir);
      const before = registry();
      const d = withMarketplace(deps({ fetched: clientPackage('1.2.0', 1), homedir }));

      const argv = [CLIENT, '--agent', 'claude-code', '-g', '--categories', 'git,plugin:bluecube-sdlc', '--yes'];
      assert.equal(await main(argv, d), EXIT.OK);

      const unoffered = [{ name: 'bluecube-gauntlet', scope: 'user' }];
      assert.ok(d.log.lines.includes(messages.pluginsNotOffered(CLIENT, unoffered, 'switch')));
      assert.deepEqual(claudeCalls(d), []);
      assert.deepEqual(registry(), before);
    });
  });
});
