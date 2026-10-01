import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import * as messages from './messages.js';

export const EXIT = Object.freeze({
  OK: 0,
  DEPLOY_FAILED: 1,
  PREFLIGHT: 2,
  UNSUPPORTED_HARNESS: 3,
  CANCELLED: 130,
});

export class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

const SCOPES = ['repo', 'homedir'];

const FLAGS = {
  global: { type: 'boolean', short: 'g' },
  scope: { type: 'string' },
  agent: { type: 'string' },
  categories: { type: 'string' },
  ref: { type: 'string' },
  target: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
};

/** Default install target once the scope is known. */
export function defaultTarget(scope, { cwd = process.cwd(), homedir = os.homedir() } = {}) {
  return scope === 'homedir' ? homedir : cwd;
}

export function parseCli(argv, pkg, { env = process.env, cwd = process.cwd(), homedir = os.homedir() } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: FLAGS, allowPositionals: false, strict: true }));
  } catch (err) {
    throw new CliError(EXIT.PREFLIGHT, messages.flagError(err.message));
  }

  if (values.scope !== undefined && !SCOPES.includes(values.scope)) {
    throw new CliError(EXIT.PREFLIGHT, messages.scopeInvalid(values.scope));
  }
  if (values.global && values.scope === 'repo') {
    throw new CliError(EXIT.PREFLIGHT, messages.scopeConflict);
  }
  const scope = values.global ? 'homedir' : (values.scope ?? null);

  const categories = values.categories === undefined
    ? null
    : values.categories.split(',').map((id) => id.trim()).filter(Boolean);

  const yes = Boolean(values.yes);
  const target = values.target === undefined ? null : path.resolve(cwd, values.target);

  return {
    help: Boolean(values.help),
    version: Boolean(values.version),
    scope,
    agent: values.agent ?? null,
    categories,
    ref: values.ref ?? pkg.bluecube.sdkRef,
    target,
    targetGiven: target !== null,
    yes,
    dryRun: Boolean(values['dry-run']),
    nonInteractive: yes && Boolean(values.agent) && scope !== null && categories !== null,
    sdkUrl: env.BLUECUBE_SDK_URL || pkg.bluecube.sdkRepo,
    cacheDir: env.BLUECUBE_CACHE_DIR || path.join(homedir, '.bluecube', 'cache', 'sources'),
    cwd,
    homedir,
  };
}
