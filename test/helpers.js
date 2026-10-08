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
    text: answer('text'),
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

export function tmpCache() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-cli-'));
}

/**
 * Fake exec that simulates git (creating the slot on clone, with `slotFiles` as {name: data}
 * written into it), uv for catalog and deploy, and a current claude CLI whose plugin commands
 * answer with `claude`.
 */
export function catalogExec({
  deployCode = 0, claude = () => ({}), fixture = 'catalog-claude-code.json', slotFiles = {},
} = {}) {
  return fakeExec(async (cmd, args) => {
    if (cmd === 'claude') return args.includes('--help') ? { stdout: '--scope --sparse' } : claude(args);
    if (cmd === 'git' && args[0] === 'clone') {
      fs.mkdirSync(path.join(args[2], '.git'), { recursive: true });
      for (const [name, data] of Object.entries(slotFiles)) writeJson(path.join(args[2], name), data);
    }
    if (cmd === 'git' && args[0] === 'rev-parse') return { stdout: 'a'.repeat(40) };
    if (cmd === 'uv' && args.includes('--list-categories')) {
      return { stdout: fs.readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8') };
    }
    if (cmd === 'uv') return { code: deployCode };
    return {};
  });
}
