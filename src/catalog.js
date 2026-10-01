import { CliError, EXIT } from './cli.js';
import * as messages from './messages.js';

export const SCHEMA_VERSION = 1;
export const DEFAULT_AGENT = 'claude-code';

// The first `uv run` of deploy.py installs its Python dependencies.
const CATALOG_TIMEOUT_MS = 180000;

/** Run the SDK's `deploy.py --list-categories --json` in the checked-out slot and validate it. */
export async function readCatalog({ exec, root, agent = DEFAULT_AGENT, ref }) {
  const result = await exec(
    'uv',
    ['run', 'sdk/deploy.py', '--list-categories', '--json', '--agent', agent],
    { cwd: root, timeoutMs: CATALOG_TIMEOUT_MS },
  );
  if (result.code !== 0) {
    if (/unrecognized arguments:.*--list-categories/.test(result.stderr)) {
      throw new CliError(EXIT.PREFLIGHT, messages.catalogTooOld(ref));
    }
    throw new CliError(EXIT.PREFLIGHT, messages.catalogFailed(result.stderr));
  }

  let catalog;
  try {
    catalog = JSON.parse(result.stdout);
  } catch {
    throw new CliError(EXIT.PREFLIGHT, messages.catalogInvalid);
  }
  if (catalog?.schemaVersion !== SCHEMA_VERSION) {
    throw new CliError(EXIT.PREFLIGHT, messages.catalogSchema(catalog?.schemaVersion));
  }
  if (!Array.isArray(catalog.agents) || !Array.isArray(catalog.categories)) {
    throw new CliError(EXIT.PREFLIGHT, messages.catalogInvalid);
  }
  return catalog;
}
