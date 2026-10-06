// Shared fakes for the unit tests. Every module takes exec/which/prompt injected.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function fakeExec(handler = () => ({ code: 0, stdout: '', stderr: '' })) {
  const calls = [];
  const exec = async (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    const result = await handler(cmd, args, opts);
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...result };
  };
  exec.calls = calls;
  return exec;
}

export function fakeWhich(present) {
  return (name) => (present.includes(name) ? `/usr/bin/${name}` : null);
}

export function fakePrompt(answers = {}) {
  const asked = [];
  const answer = (kind) => async (opts) => {
    asked.push({ kind, ...opts });
    const queue = answers[kind];
    if (Array.isArray(queue)) return queue.shift();
    if (typeof queue === 'function') return queue(opts);
    return queue;
  };
  return {
    confirm: answer('confirm'),
    select: answer('select'),
    groupMultiselect: answer('groupMultiselect'),
    asked,
  };
}

export function collectLog() {
  const lines = [];
  const log = (line) => lines.push(line);
  log.lines = lines;
  return log;
}

/** Fresh temporary home config directory and repo target for registry tests (nothing created yet). */
export function registryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-registry-'));
  return { root, configDir: path.join(root, 'home', '.claude'), target: path.join(root, 'repo') };
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** Inline marketplace in the shape deploy.py writes, for [[name, copiedDir], ...]. */
export function legacyDeclaration(plugins) {
  return {
    source: {
      source: 'settings',
      name: 'bluecube-coder',
      plugins: plugins.map(([name, dir]) => ({
        name,
        description: '',
        version: '1.1.1',
        source: { source: 'url', url: pathToFileURL(dir).href },
        strict: false,
      })),
    },
  };
}
