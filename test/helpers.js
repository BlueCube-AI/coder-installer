// Shared fakes for the unit tests. Every module takes exec/which/prompt injected.

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
