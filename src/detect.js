// Binary name on PATH for each harness, keyed by the agent name the SDK catalog uses.
export const HARNESSES = [
  { name: 'claude-code', binary: 'claude' },
  { name: 'codex', binary: 'codex' },
  { name: 'pi', binary: 'pi' },
  { name: 'opencode', binary: 'opencode' },
];

export function detectHarnesses({ which }) {
  return HARNESSES
    .map(({ name, binary }) => ({ name, binary, path: which(binary) }))
    .filter((harness) => harness.path);
}

export function detectTools({ which }) {
  return { uv: which('uv'), git: which('git'), node: process.version };
}
