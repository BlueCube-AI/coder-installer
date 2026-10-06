import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  claudeConfigDir, compareVersions, installedPlugins, readRegistration, registryPaths,
  restoreRegistry, snapshotRegistry, stripRegistration,
} from '../src/registry.js';
import { legacyDeclaration, registryFixture, writeJson } from './helpers.js';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('claudeConfigDir', () => {
  it('should prefer CLAUDE_CONFIG_DIR over ~/.claude', () => {
    assert.equal(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '/cfg' }, homedir: '/h' }), '/cfg');
    assert.equal(claudeConfigDir({ env: {}, homedir: '/h' }), path.join('/h', '.claude'));
  });
});

describe('registryPaths', () => {
  it('should include the repo settings file only on a repo run', () => {
    const repo = registryPaths({ configDir: '/c', target: '/w', scope: 'repo' });
    assert.equal(repo.repoSettings, path.join('/w', '.claude', 'settings.local.json'));
    assert.equal(registryPaths({ configDir: '/c', target: '/h', scope: 'homedir' }).repoSettings, null);
  });
});

describe('readRegistration', () => {
  it('should list the enabled home legacy plugins at user scope with their leftover directories', () => {
    const { configDir, target } = registryFixture();
    const sdlcDir = path.join(configDir, 'plugins', 'bluecube-sdlc');
    const kbDir = path.join(configDir, 'plugins', 'kb-knowledge-graph');
    writeJson(path.join(configDir, 'settings.json'), {
      extraKnownMarketplaces: { 'bluecube-coder': legacyDeclaration([['bluecube-sdlc', sdlcDir], ['kb-knowledge-graph', kbDir]]) },
      enabledPlugins: { 'bluecube-sdlc@bluecube-coder': true },
    });

    const registration = readRegistration({ configDir, target, scope: 'homedir' });

    assert.equal(registration.declared, null);
    assert.deepEqual(registration.legacy.plugins, [{ name: 'bluecube-sdlc', scope: 'user' }]);
    assert.deepEqual(registration.legacy.leftoverDirs, [sdlcDir, kbDir]);
  });

  it('should list the enabled repo legacy plugins at project scope and skip directories of other repos', () => {
    const { root, configDir, target } = registryFixture();
    const repoDir = path.join(target, 'plugins', 'bluecube-sdlc');
    const otherRepoDir = path.join(root, 'other-repo', 'plugins', 'kb-knowledge-graph');
    const declaration = legacyDeclaration([['bluecube-sdlc', repoDir], ['kb-knowledge-graph', otherRepoDir]]);
    writeJson(path.join(configDir, 'settings.json'), { extraKnownMarketplaces: { 'bluecube-coder': declaration } });
    writeJson(path.join(target, '.claude', 'settings.local.json'), {
      extraKnownMarketplaces: { 'bluecube-coder': declaration },
      enabledPlugins: { 'bluecube-sdlc@bluecube-coder': true },
    });

    const { legacy } = readRegistration({ configDir, target, scope: 'repo' });

    assert.deepEqual(legacy.plugins, [{ name: 'bluecube-sdlc', scope: 'project' }]);
    assert.deepEqual(legacy.leftoverDirs, [repoDir]);
  });

  it('should not read the repo settings file on a homedir run', () => {
    const { configDir, target } = registryFixture();
    writeJson(path.join(target, '.claude', 'settings.local.json'), {
      extraKnownMarketplaces: { 'bluecube-coder': legacyDeclaration([['bluecube-sdlc', path.join(target, 'plugins', 'bluecube-sdlc')]]) },
      enabledPlugins: { 'bluecube-sdlc@bluecube-coder': true },
    });

    assert.deepEqual(readRegistration({ configDir, target, scope: 'homedir' }), { declared: null, legacy: null });
  });

  it('should skip a leftover directory that is not named after its plugin', () => {
    const { configDir, target } = registryFixture();
    writeJson(path.join(configDir, 'settings.json'), {
      extraKnownMarketplaces: { 'bluecube-coder': legacyDeclaration([['bluecube-sdlc', path.join(configDir, 'plugins')]]) },
    });

    assert.deepEqual(readRegistration({ configDir, target, scope: 'homedir' }).legacy.leftoverDirs, []);
  });

  for (const source of [
    { source: 'github', repo: 'BlueCube-AI/bluecube-coder' },
    { source: 'git', url: 'https://github.com/BlueCube-AI/bluecube-coder.git', sparsePaths: ['.claude-plugin', 'plugins'] },
    { source: 'directory', path: '/src/bluecube-coder' },
  ]) {
    it(`should return a ${source.source} declaration with no legacy state`, () => {
      const { configDir, target } = registryFixture();
      writeJson(path.join(configDir, 'settings.json'), { extraKnownMarketplaces: { 'bluecube-coder': { source } } });

      assert.deepEqual(readRegistration({ configDir, target, scope: 'repo' }), { declared: source, legacy: null });
    });
  }

  it('should read missing and invalid files as empty', () => {
    const { configDir, target } = registryFixture();
    assert.deepEqual(readRegistration({ configDir, target, scope: 'repo' }), { declared: null, legacy: null });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'settings.json'), '{ not json');
    assert.deepEqual(readRegistration({ configDir, target, scope: 'repo' }), { declared: null, legacy: null });
  });
});

describe('installedPlugins', () => {
  function writeInstalled(configDir, target) {
    writeJson(path.join(configDir, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'bluecube-sdlc@bluecube-coder': [
          { scope: 'user', version: '1.1.0' },
          { scope: 'project', projectPath: target, version: '1.1.1' },
          { scope: 'project', projectPath: '/elsewhere', version: '1.0.0' },
        ],
        'cloudflare@cloudflare': [{ scope: 'user', version: '1.0.0' }],
      },
    });
  }

  it('should return user entries and project entries of the current target on a repo run', () => {
    const { configDir, target } = registryFixture();
    writeInstalled(configDir, target);

    assert.deepEqual(installedPlugins({ configDir, target, scope: 'repo' }), [
      { name: 'bluecube-sdlc', scope: 'user', version: '1.1.0' },
      { name: 'bluecube-sdlc', scope: 'project', version: '1.1.1' },
    ]);
  });

  it('should return only user entries on a homedir run', () => {
    const { configDir, target } = registryFixture();
    writeInstalled(configDir, target);

    assert.deepEqual(installedPlugins({ configDir, target, scope: 'homedir' }), [
      { name: 'bluecube-sdlc', scope: 'user', version: '1.1.0' },
    ]);
  });
});

describe('snapshotRegistry, stripRegistration and restoreRegistry', () => {
  // Four-space indentation and no trailing newline, so a rewrite changes the bytes.
  const writeLoose = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 4));
  };

  function legacyRegistry() {
    const { configDir, target } = registryFixture();
    const paths = registryPaths({ configDir, target, scope: 'repo' });
    const declaration = legacyDeclaration([['bluecube-sdlc', path.join(configDir, 'plugins', 'bluecube-sdlc')]]);
    writeLoose(paths.homeSettings, {
      extraKnownMarketplaces: { 'bluecube-coder': declaration, cloudflare: { source: { source: 'github', repo: 'cloudflare/skills' } } },
      enabledPlugins: { 'bluecube-sdlc@bluecube-coder': true },
      model: 'opus',
    });
    writeLoose(paths.repoSettings, {
      extraKnownMarketplaces: { 'bluecube-coder': declaration },
      enabledPlugins: { 'kb-knowledge-graph@bluecube-coder': true },
    });
    writeLoose(paths.installed, {
      version: 2,
      plugins: {
        'bluecube-sdlc@bluecube-coder': [{ scope: 'user', version: '1.1.0' }],
        'kb-knowledge-graph@bluecube-coder': [
          { scope: 'project', projectPath: target, version: '0.7.2' },
          { scope: 'project', projectPath: '/other-repo', version: '0.7.2' },
        ],
        'cloudflare@cloudflare': [{ scope: 'user', version: '1.0.0' }],
      },
    });
    const carried = [{ name: 'bluecube-sdlc', scope: 'user' }, { name: 'kb-knowledge-graph', scope: 'project' }];
    return { paths, target, carried };
  }

  it('should restore every file byte for byte after a strip', () => {
    const { paths, target, carried } = legacyRegistry();
    writeLoose(paths.known, { 'bluecube-coder': {}, cloudflare: {} });
    const before = Object.values(paths).map((file) => fs.readFileSync(file));

    const snapshot = snapshotRegistry(paths);
    stripRegistration({ paths, carried, target });
    assert.notDeepEqual(Object.values(paths).map((file) => fs.readFileSync(file)), before);
    restoreRegistry(snapshot);

    assert.deepEqual(Object.values(paths).map((file) => fs.readFileSync(file)), before);
  });

  it('should delete on restore a file that was absent in the snapshot', () => {
    const { paths } = legacyRegistry();
    const snapshot = snapshotRegistry(paths);
    assert.equal(snapshot[paths.known], null);
    writeJson(paths.known, { 'bluecube-coder': {} });

    restoreRegistry(snapshot);

    assert.equal(fs.existsSync(paths.known), false);
  });

  it('should strip only the bluecube-coder registration and the carried install entries', () => {
    const { paths, target, carried } = legacyRegistry();

    stripRegistration({ paths, carried, target });

    const home = readJson(paths.homeSettings);
    assert.deepEqual(Object.keys(home.extraKnownMarketplaces), ['cloudflare']);
    assert.deepEqual(home.enabledPlugins, { 'bluecube-sdlc@bluecube-coder': true });
    assert.equal(home.model, 'opus');
    assert.match(fs.readFileSync(paths.homeSettings, 'utf8'), /^\{\n {2}"extraKnownMarketplaces"[\s\S]*\}\n$/);
    const repo = readJson(paths.repoSettings);
    assert.deepEqual(repo.extraKnownMarketplaces, {});
    assert.deepEqual(repo.enabledPlugins, { 'kb-knowledge-graph@bluecube-coder': true });
    assert.deepEqual(readJson(paths.installed).plugins, {
      'kb-knowledge-graph@bluecube-coder': [{ scope: 'project', projectPath: '/other-repo', version: '0.7.2' }],
      'cloudflare@cloudflare': [{ scope: 'user', version: '1.0.0' }],
    });
    assert.equal(fs.existsSync(paths.known), false);
  });
});

describe('compareVersions', () => {
  it('should order dotted numeric versions', () => {
    const ordered = ['1.1.0', '1.1.1', '1.2', '1.10.0'];
    for (let i = 0; i < ordered.length - 1; i++) {
      assert.equal(compareVersions(ordered[i], ordered[i + 1]), -1);
      assert.equal(compareVersions(ordered[i + 1], ordered[i]), 1);
    }
    assert.equal(compareVersions('1.2', '1.2.0'), 0);
  });

  it('should return null for a non-numeric version', () => {
    assert.equal(compareVersions('8331f9108451', '1.0.0'), null);
    assert.equal(compareVersions('1.0.0', null), null);
  });
});
