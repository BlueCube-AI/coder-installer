import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const WINDOWS_SCRIPT = /\.(cmd|bat)$/i;

/**
 * Run a process with an argv array (never a shell string) and collect its output.
 * Resolves, never rejects: a spawn failure comes back as code 127 with the error in stderr.
 */
export function run(cmd, args = [], { cwd, env, timeoutMs, stdio = 'pipe', platform = process.platform } = {}) {
  let file = cmd;
  let argv = args;
  // Node refuses to spawn .cmd/.bat files without a shell (CVE-2024-27980), and npm-installed
  // CLIs such as claude.cmd are exactly that on Windows. cmd.exe runs them with the argv array
  // Node quotes for us; no command string is ever built from user input.
  if (platform === 'win32' && WINDOWS_SCRIPT.test(cmd)) {
    file = process.env.ComSpec || 'cmd.exe';
    argv = ['/d', '/s', '/c', cmd, ...args];
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(file, argv, {
        cwd,
        env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
        stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: 127, stdout, stderr: err.message, timedOut });
      return;
    }

    const timer = timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs)
      : null;

    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + err.message, timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr, timedOut });
    });
  });
}

function isExecutable(file, platform) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (platform === 'win32') return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find `name` on PATH and return its full path, or null. On Windows every PATHEXT
 * extension is tried, so `which('claude')` finds `claude.cmd`.
 */
export function which(name, {
  pathEnv = process.env.PATH ?? process.env.Path ?? '',
  pathExt = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
  platform = process.platform,
  exists = (file) => isExecutable(file, platform),
} = {}) {
  const lib = platform === 'win32' ? path.win32 : path.posix;
  const extensions = platform === 'win32'
    ? pathExt.split(';').filter(Boolean).map((ext) => ext.toLowerCase())
    : [''];
  for (const dir of pathEnv.split(lib.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = lib.join(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}
