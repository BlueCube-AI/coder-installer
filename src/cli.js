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

// `owner/name` of a GitHub repository; a trailing .git is dropped.
const OWNER_NAME = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/;
// The GitHub HTTPS and SSH URL forms a repository slug is read from.
const GITHUB_URLS = [
  /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/i,
  /^git@github\.com:([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/i,
];
// A URL with a scheme (https://, ssh://, file://) or the scp-like user@host:path form.
const GIT_URL = /^([a-z][a-z0-9+.-]*:\/\/|[^@\s/]+@[^:\s/]+:)/i;
// Each publish to a client repository is a new commit on main.
const CLIENT_REF = 'main';

const FLAGS = {
  repo: { type: 'string' },
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

/**
 * The folder a run writes to, as the user reads it. The headless deploy writes to
 * <target>/<configDir>, and its home target is the home directory.
 */
export function installDir({ scope, agent, cwd, target }) {
  if (scope === 'repo') return path.join(target ?? cwd, agent.configDir);
  return target ? path.join(target, agent.configDir) : `~/${agent.configDir}`;
}

export const isOwnerName = (value) => OWNER_NAME.test(value);

/** The GitHub `owner/name` a git URL points at, or null for any other URL (file:// included). */
export function repoSlugOf(url) {
  for (const pattern of GITHUB_URLS) {
    const match = pattern.exec(url);
    if (match) return match[1];
  }
  return null;
}

function gitUrl(repo) {
  const ownerName = OWNER_NAME.exec(repo);
  if (ownerName) return `https://github.com/${ownerName[1]}/${ownerName[2]}.git`;
  if (GIT_URL.test(repo)) return repo;
  throw new CliError(EXIT.PREFLIGHT, messages.repoInvalid(repo));
}

/**
 * Where a run installs from. `repo` is `owner/name`, a git URL or null; BLUECUBE_SDK_URL
 * replaces its URL. The ref defaults to main for a client repository and to the pinned SDK
 * ref for the SDK repository and any URL that names no GitHub repository; `ref` always wins.
 * Without a repository sdkUrl is null and the run has to ask for one.
 */
export function repositorySource(repo, pkg, { env = {}, ref = null } = {}) {
  const given = repo === null ? null : gitUrl(repo);
  const sdkUrl = env.BLUECUBE_SDK_URL || given;
  if (!sdkUrl) return { sdkUrl: null, repoSlug: null, ref };
  const repoSlug = repoSlugOf(sdkUrl);
  const isClient = repoSlug !== null && repoSlug.toLowerCase() !== messages.SDK_REPO.toLowerCase();
  return { sdkUrl, repoSlug, ref: ref ?? (isClient ? CLIENT_REF : pkg.bluecube.sdkRef) };
}

export function parseCli(argv, pkg, { env = process.env, cwd = process.cwd(), homedir = os.homedir() } = {}) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({ args: argv, options: FLAGS, allowPositionals: true, strict: true }));
  } catch (err) {
    throw new CliError(EXIT.PREFLIGHT, messages.flagError(err.message));
  }
  if (positionals.length > 1 || (positionals.length && values.repo !== undefined)) {
    throw new CliError(EXIT.PREFLIGHT, messages.repoConflict);
  }

  if (values.scope !== undefined && !SCOPES.includes(values.scope)) {
    throw new CliError(EXIT.PREFLIGHT, messages.scopeInvalid(values.scope));
  }
  if (values.global && values.scope === 'repo') {
    throw new CliError(EXIT.PREFLIGHT, messages.scopeConflict);
  }
  const scope = values.global ? 'homedir' : (values.scope ?? null);
  // The flag that chose the home scope, so a refusal names what the user typed.
  let scopeFlag = null;
  if (values.global) scopeFlag = '-g';
  else if (values.scope === 'homedir') scopeFlag = '--scope homedir';

  const categories = values.categories === undefined
    ? null
    : values.categories.split(',').map((id) => id.trim()).filter(Boolean);

  const yes = Boolean(values.yes);
  const target = values.target === undefined ? null : path.resolve(cwd, values.target);

  return {
    help: Boolean(values.help),
    version: Boolean(values.version),
    ...repositorySource(positionals[0] ?? values.repo ?? null, pkg, { env, ref: values.ref ?? null }),
    scope,
    scopeFlag,
    agent: values.agent ?? null,
    categories,
    target,
    targetGiven: target !== null,
    yes,
    dryRun: Boolean(values['dry-run']),
    nonInteractive: yes && Boolean(values.agent) && scope !== null && categories !== null,
    cacheDir: env.BLUECUBE_CACHE_DIR || path.join(homedir, '.bluecube', 'cache', 'sources'),
    cwd,
    homedir,
  };
}
