import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALLOWED_PREFIXES = ['bin/', 'src/', 'README.md', 'LICENSE', 'package.json'];
const SDK_CONTENT = ['commands/', 'agents/', 'skills/', 'references/', 'harnesses/', 'plugins/'];
const NATIVE = /\.(node|so|dylib|exe)$/i;

function packedFiles() {
  const isWindows = process.platform === 'win32';
  // npm is npm.cmd on Windows, which Node only spawns through a shell.
  const out = execFileSync(isWindows ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT, encoding: 'utf8', shell: isWindows,
  });
  return JSON.parse(out)[0].files.map((file) => file.path.replace(/\\/g, '/'));
}

describe('npm tarball', () => {
  const files = packedFiles();

  it('should ship only bin/, src/, README.md, LICENSE and package.json', () => {
    for (const file of files) {
      assert.ok(ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix)), `unexpected file in tarball: ${file}`);
    }
    assert.ok(files.includes('bin/coder.js'));
    assert.ok(files.length < 40, `${files.length} files`);
  });

  it('should carry no SDK content and no native binary', () => {
    for (const file of files) {
      assert.ok(!SDK_CONTENT.some((dir) => file.includes(dir)), `SDK content in tarball: ${file}`);
      assert.ok(!NATIVE.test(file), `native binary in tarball: ${file}`);
    }
  });

  it('should have no postinstall script and one exact runtime dependency', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.scripts?.postinstall, undefined);
    assert.equal(pkg.devDependencies, undefined);
    const deps = Object.entries(pkg.dependencies);
    assert.equal(deps.length, 1);
    assert.match(deps[0][1], /^\d+\.\d+\.\d+$/);
  });
});
