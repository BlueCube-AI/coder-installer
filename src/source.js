import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CliError, EXIT } from './cli.js';
import * as messages from './messages.js';

// Cache contract shared with the SDK's source resolver: same slot name, git commands and
// source.json. Change both sides together.
const CLONE_TIMEOUT_MS = 300000;
const FETCH_TIMEOUT_MS = 60000;
const LOCAL_TIMEOUT_MS = 30000;

export function cacheSlot(cacheDir, url) {
  return path.join(cacheDir, createHash('sha256').update(url).digest('hex').slice(0, 16));
}

async function git(exec, args, cwd, timeoutMs) {
  return exec('git', args, { cwd, timeoutMs });
}

async function isHealthySlot(exec, slot) {
  if (!fs.existsSync(path.join(slot, '.git'))) return false;
  const status = await git(exec, ['status', '--porcelain'], slot, LOCAL_TIMEOUT_MS);
  return status.code === 0;
}

async function resolveCommit(exec, slot, ref) {
  // A branch name must follow the remote after a fetch, so origin/<ref> wins over a stale
  // local branch of the same name. Tags and commits fall through to the plain form.
  const remote = await git(exec, ['rev-parse', '--verify', '--quiet', `origin/${ref}^{commit}`], slot, LOCAL_TIMEOUT_MS);
  if (remote.code === 0) return remote.stdout.trim();
  const plain = await git(exec, ['rev-parse', '--verify', `${ref}^{commit}`], slot, LOCAL_TIMEOUT_MS);
  if (plain.code !== 0) throw new CliError(EXIT.PREFLIGHT, messages.sourceUnknownRef(ref, plain.stderr));
  return plain.stdout.trim();
}

/**
 * Clone or fetch the SDK into its cache slot, check `ref` out detached and record source.json.
 * Returns {root, revision, ref, url}.
 */
export async function resolveSource({ exec, cacheDir, url, ref, log, confirm, yes, now = () => new Date() }) {
  const slot = cacheSlot(cacheDir, url);

  if (fs.existsSync(slot) && !(await isHealthySlot(exec, slot))) {
    log(messages.sourceBrokenSlot(slot));
    const accepted = yes || await confirm({ message: messages.sourceBrokenConfirm, initialValue: true });
    if (!accepted) throw new CliError(EXIT.PREFLIGHT, messages.sourceBrokenDeclined(slot));
    fs.rmSync(slot, { recursive: true, force: true });
  }

  if (fs.existsSync(slot)) {
    log(messages.sourceFetch(slot));
    const fetched = await git(exec, ['fetch', '--tags', 'origin'], slot, FETCH_TIMEOUT_MS);
    if (fetched.code !== 0) throw new CliError(EXIT.PREFLIGHT, messages.sourceGitFailed('fetch', fetched.stderr));
  } else {
    log(messages.sourceClone(url, slot));
    fs.mkdirSync(cacheDir, { recursive: true });
    const cloned = await git(exec, ['clone', url, slot], cacheDir, CLONE_TIMEOUT_MS);
    if (cloned.code !== 0) throw new CliError(EXIT.PREFLIGHT, messages.sourceGitFailed('clone', cloned.stderr));
  }

  const revision = await resolveCommit(exec, slot, ref);
  const checkout = await git(exec, ['checkout', '--detach', revision], slot, LOCAL_TIMEOUT_MS);
  if (checkout.code !== 0) throw new CliError(EXIT.PREFLIGHT, messages.sourceGitFailed('checkout', checkout.stderr));

  const record = { url, ref, revision, resolved_at: now().toISOString() };
  fs.writeFileSync(path.join(slot, 'source.json'), `${JSON.stringify(record, null, 2)}\n`);
  log(messages.sourceResolved(ref, revision));
  return { root: slot, revision, ref, url };
}
