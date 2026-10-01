import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectHarnesses, detectTools } from '../src/detect.js';
import { which } from '../src/exec.js';

describe('detectHarnesses', () => {
  it('should find the four harnesses on a posix PATH', () => {
    const files = new Set(['/opt/bin/claude', '/usr/local/bin/codex', '/usr/local/bin/pi', '/opt/bin/opencode']);
    const whichFn = (name) => which(name, { pathEnv: '/usr/local/bin:/opt/bin', platform: 'linux', exists: (f) => files.has(f) });
    assert.deepEqual(detectHarnesses({ which: whichFn }), [
      { name: 'claude-code', binary: 'claude', path: '/opt/bin/claude' },
      { name: 'codex', binary: 'codex', path: '/usr/local/bin/codex' },
      { name: 'pi', binary: 'pi', path: '/usr/local/bin/pi' },
      { name: 'opencode', binary: 'opencode', path: '/opt/bin/opencode' },
    ]);
  });

  it('should honour PATHEXT on win32', () => {
    const files = new Set(['C:\\npm\\claude.cmd', 'C:\\bin\\opencode.exe', 'C:\\bin\\pi.cmd']);
    const whichFn = (name) => which(name, {
      pathEnv: 'C:\\bin;C:\\npm', pathExt: '.COM;.EXE;.BAT;.CMD', platform: 'win32', exists: (f) => files.has(f),
    });
    assert.deepEqual(detectHarnesses({ which: whichFn }).map((h) => h.path), [
      'C:\\npm\\claude.cmd', 'C:\\bin\\pi.cmd', 'C:\\bin\\opencode.exe',
    ]);
  });

  it('should return nothing on an empty PATH', () => {
    const whichFn = (name) => which(name, { pathEnv: '', platform: 'linux', exists: () => true });
    assert.deepEqual(detectHarnesses({ which: whichFn }), []);
  });
});

describe('detectTools', () => {
  it('should report uv, git and the node version', () => {
    const tools = detectTools({ which: (name) => (name === 'git' ? '/usr/bin/git' : null) });
    assert.equal(tools.uv, null);
    assert.equal(tools.git, '/usr/bin/git');
    assert.equal(tools.node, process.version);
  });
});
