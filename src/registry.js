import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The Claude Code plugin registry: the files Claude Code reads for marketplaces and installed
// plugins. The claude CLI can neither see nor remove the legacy registration below, so these
// files are edited directly, touching only the bluecube-coder keys.
//
// Legacy shape, written by `_register_plugin` in the SDK's sdk/deploy_modules/api/deploy_runner.py:
// `extraKnownMarketplaces['bluecube-coder'].source` is `{ source: 'settings', plugins: [...] }`,
// each plugin pointing at a copied directory through `{ source: 'url', url: 'file://...' }`.
// The declaration goes into ~/.claude/settings.json, and on a repo install also into the repo's
// .claude/settings.local.json, which carries that repo's `enabledPlugins` entry.

export const MARKETPLACE_NAME = 'bluecube-coder';
const PLUGIN_KEY_SUFFIX = `@${MARKETPLACE_NAME}`;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Parsed JSON object, or {} when the file is missing, unreadable or not a JSON object. */
function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}

// Two-space indentation and a trailing newline: the format deploy.py and Claude Code write.
function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function isInside(dir, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(dir));
  return relative !== '' && relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative);
}

const declaration = (settings) => settings.extraKnownMarketplaces?.[MARKETPLACE_NAME]?.source ?? null;
const isLegacy = (source) => source?.source === 'settings';

/** Claude Code's config directory: CLAUDE_CONFIG_DIR when set, else ~/.claude. */
export function claudeConfigDir({ env, homedir }) {
  return env?.CLAUDE_CONFIG_DIR || path.join(homedir, '.claude');
}

/** The four registry files a run owns. `repoSettings` is null on a homedir run. */
export function registryPaths({ configDir, target, scope }) {
  return {
    homeSettings: path.join(configDir, 'settings.json'),
    repoSettings: scope === 'repo' ? path.join(target, '.claude', 'settings.local.json') : null,
    installed: path.join(configDir, 'plugins', 'installed_plugins.json'),
    known: path.join(configDir, 'plugins', 'known_marketplaces.json'),
  };
}

function legacyDirectory(plugin, { configDir, target, scope }) {
  const url = plugin?.source?.url;
  if (typeof url !== 'string' || !url.startsWith('file:')) return null;
  let dir;
  try {
    dir = fileURLToPath(url);
  } catch {
    return null;
  }
  // The directory is deleted recursively later, so it must be the plugin's own copy
  // (deploy.py names it after the plugin), never a parent such as ~/.claude/plugins.
  if (path.basename(dir) !== plugin.name) return null;
  const owned = isInside(dir, configDir) || (scope === 'repo' && isInside(dir, target));
  return owned ? dir : null;
}

/**
 * The bluecube-coder registration as the settings files declare it.
 * `declared` is the home declaration when it is not legacy (github, git, directory), else null.
 * `legacy` is null without a legacy declaration, else {plugins: [{name, scope}], leftoverDirs}.
 */
export function readRegistration({ configDir, target, scope }) {
  const paths = registryPaths({ configDir, target, scope });
  const home = readJson(paths.homeSettings);
  const repo = paths.repoSettings ? readJson(paths.repoSettings) : {};
  const homeSource = declaration(home);
  const declared = homeSource && !isLegacy(homeSource) ? homeSource : null;

  const legacySettings = [
    { settings: home, pluginScope: 'user' },
    { settings: repo, pluginScope: 'project' },
  ].filter(({ settings }) => isLegacy(declaration(settings)));
  if (legacySettings.length === 0) return { declared, legacy: null };

  const plugins = [];
  const leftoverDirs = [];
  for (const { settings, pluginScope } of legacySettings) {
    const listed = declaration(settings).plugins;
    for (const plugin of Array.isArray(listed) ? listed : []) {
      if (settings.enabledPlugins?.[`${plugin?.name}${PLUGIN_KEY_SUFFIX}`] === true) {
        plugins.push({ name: plugin.name, scope: pluginScope });
      }
      const dir = legacyDirectory(plugin, { configDir, target, scope });
      if (dir && !leftoverDirs.includes(dir)) leftoverDirs.push(dir);
    }
  }
  return { declared, legacy: { plugins, leftoverDirs } };
}

function isConsideredEntry(entry, { target, scope }) {
  if (scope !== 'repo') return entry?.scope === 'user';
  return entry?.scope === 'project' && typeof entry.projectPath === 'string'
    && path.resolve(entry.projectPath) === path.resolve(target);
}

function installedEntries(configDir) {
  const data = readJson(path.join(configDir, 'plugins', 'installed_plugins.json'));
  return isObject(data.plugins) ? data.plugins : {};
}

/**
 * Installed bluecube-coder plugins at the run's own scope: user scope on a home run, project
 * scope for the current target on a repo run. Returns [{name, scope, version}].
 */
export function installedPlugins({ configDir, target, scope }) {
  const found = [];
  for (const [key, entries] of Object.entries(installedEntries(configDir))) {
    if (!key.endsWith(PLUGIN_KEY_SUFFIX) || !Array.isArray(entries)) continue;
    const name = key.slice(0, -PLUGIN_KEY_SUFFIX.length);
    for (const entry of entries) {
      if (isConsideredEntry(entry, { target, scope })) found.push({ name, scope: entry.scope, version: entry.version ?? null });
    }
  }
  return found;
}

/**
 * The source Claude Code last added the bluecube-coder marketplace from, or null. The machine
 * keeps one per marketplace name, whichever settings file declared it.
 */
export function knownSource(paths) {
  const source = readJson(paths.known)[MARKETPLACE_NAME]?.source;
  return isObject(source) ? source : null;
}

/** Raw bytes of each registry file, or null when it is absent. */
export function snapshotRegistry(paths) {
  const snapshot = {};
  for (const file of Object.values(paths).filter(Boolean)) {
    try {
      snapshot[file] = fs.readFileSync(file);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      snapshot[file] = null;
    }
  }
  return snapshot;
}

// Claude Code's working copy of the marketplace. `claude plugin marketplace add` deletes it and
// clones the new source there, and a session reads plugins from it even for a legacy declaration,
// so a rollback that restored only the registry files would leave the new source in charge.
const marketplaceDir = (paths) => path.join(path.dirname(paths.known), 'marketplaces', MARKETPLACE_NAME);
const PARKED_SUFFIX = '.bluecube-rollback';

/** Move the marketplace copy aside before a migration. Returns the parked path, or null. */
export function parkMarketplace(paths) {
  const dir = marketplaceDir(paths);
  if (!fs.existsSync(dir)) return null;
  const parked = `${dir}${PARKED_SUFFIX}`;
  fs.rmSync(parked, { recursive: true, force: true });
  fs.renameSync(dir, parked);
  return parked;
}

/** Drop the copy the migration created and put the parked one, if any, back in its place. */
export function restoreMarketplace(paths, parked) {
  const dir = marketplaceDir(paths);
  fs.rmSync(dir, { recursive: true, force: true });
  if (parked) fs.renameSync(parked, dir);
}

/** Write every file back byte for byte, and delete the ones the snapshot did not have. */
export function restoreRegistry(snapshot) {
  for (const [file, content] of Object.entries(snapshot)) {
    if (content === null) {
      fs.rmSync(file, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

function isCarriedEntry(entry, name, carried, target) {
  return carried.some((plugin) => plugin.name === name && plugin.scope === entry?.scope
    && (plugin.scope === 'user' || (typeof entry.projectPath === 'string'
      && path.resolve(entry.projectPath) === path.resolve(target))));
}

/**
 * Remove the bluecube-coder registration so `claude plugin marketplace add` can register it
 * again: the declaration in both settings files, the known_marketplaces.json key and the
 * install entries of the carried plugins. `enabledPlugins` stays, so each plugin stays enabled
 * where it was. Files that do not exist are never created.
 */
export function stripRegistration({ paths, carried, target }) {
  for (const file of [paths.homeSettings, paths.repoSettings]) {
    if (!file || !fs.existsSync(file)) continue;
    const settings = readJson(file);
    if (!isObject(settings.extraKnownMarketplaces) || !(MARKETPLACE_NAME in settings.extraKnownMarketplaces)) continue;
    delete settings.extraKnownMarketplaces[MARKETPLACE_NAME];
    writeJson(file, settings);
  }

  if (fs.existsSync(paths.known)) {
    const known = readJson(paths.known);
    if (MARKETPLACE_NAME in known) {
      delete known[MARKETPLACE_NAME];
      writeJson(paths.known, known);
    }
  }

  if (fs.existsSync(paths.installed)) {
    const data = readJson(paths.installed);
    if (!isObject(data.plugins)) return;
    let changed = false;
    for (const [key, entries] of Object.entries(data.plugins)) {
      if (!key.endsWith(PLUGIN_KEY_SUFFIX) || !Array.isArray(entries)) continue;
      const name = key.slice(0, -PLUGIN_KEY_SUFFIX.length);
      const kept = entries.filter((entry) => !isCarriedEntry(entry, name, carried, target));
      if (kept.length === entries.length) continue;
      changed = true;
      if (kept.length) data.plugins[key] = kept;
      else delete data.plugins[key];
    }
    if (changed) writeJson(paths.installed, data);
  }
}

/** Dotted numeric version order: -1, 0 or 1, or null when either side is not numeric. */
export function compareVersions(a, b) {
  const parse = (version) => String(version ?? '').split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : NaN));
  const left = parse(a);
  const right = parse(b);
  if ([...left, ...right].some(Number.isNaN)) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}
