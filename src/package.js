import fs from 'node:fs';
import path from 'node:path';

import { compareVersions } from './registry.js';

// A client package carries client-package.json at its root; the SDK records the installed
// package in the client_package block of <target>/<configDir>/SDK_MANIFEST.json.
const PACKAGE_FILE = 'client-package.json';
const MANIFEST_FILE = 'SDK_MANIFEST.json';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function readJsonObject(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObject(data) ? data : null;
  } catch {
    return null;
  }
}

/** The client-package.json of a checked-out slot, or null for the full SDK. */
export function readClientPackage(slot) {
  return readJsonObject(path.join(slot, PACKAGE_FILE));
}

/** The SDK_MANIFEST.json of an agent config directory, or null before the first install. */
export function readInstalledManifest(configDir) {
  return readJsonObject(path.join(configDir, MANIFEST_FILE));
}

/**
 * True when the fetched client package is newer than the installed one: a higher SDK version,
 * or the same version with a higher revision. An install without a client_package block (the
 * full SDK, or no install yet) is never older.
 */
export function isNewer(fetched, installed) {
  const installedPackage = installed?.client_package;
  if (!fetched || !isObject(installedPackage)) return false;
  const order = compareVersions(fetched.sdkVersion, installed.sdk_version);
  if (order === null) return false;
  if (order !== 0) return order === 1;
  return Number(fetched.revision) > Number(installedPackage.revision);
}
