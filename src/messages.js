// Every sentence the installer shows to a user lives here, so wording can be
// reviewed in one place and tests can assert on the exact text.

export const SDK_REPO = 'BlueCube-AI/bluecube-coder';
export const NPX_COMMAND = 'npx @bluecube-ai/coder';

export const usage = (name) => `Usage: ${name} [<owner/repo>] [options]

Install BlueCube Coder tooling from your client repository, or from a pinned SDK release.

Arguments:
  <owner/repo>            Your client repository (for example BlueCube-AI/acme-coder) or a
                          git URL; BlueCube staff use ${SDK_REPO}

Options:
      --repo <repo>       Same as the <owner/repo> argument
  -g, --global            Install into your home directory (same as --scope homedir)
      --scope <scope>     repo (default target: current directory) or homedir
      --agent <name>      claude-code, pi or opencode
      --categories <ids>  Comma-separated category ids (skips the picker)
      --ref <ref>         Tag, branch or commit (default: main for a client repository, the
                          pinned ref for the full SDK)
      --target <path>     Install target directory
  -y, --yes               Answer yes to every confirmation
      --dry-run           Print the deploy and plugin commands without running them
  -h, --help              Show this help
      --version           Show the installer version

Without a repository the installer asks for one.
With a repository, --agent, --scope (or -g), --categories and --yes no question is asked.

Exit codes: 0 success, 1 deploy failed or plugin migration rolled back,
            2 preflight failed, 3 unsupported harness, 130 cancelled.

Environment:
  BLUECUBE_SDK_URL    Git URL to install from; replaces the repository's URL (SSH, tests)
  BLUECUBE_CACHE_DIR  Source cache (default: ~/.bluecube/cache/sources)
  DEBUG               Print stack traces for unexpected errors`;

export const intro = (version) => `BlueCube Coder installer ${version}`;

// -- flags --------------------------------------------------------------------
export const flagError = (detail) => `${detail}\nRun with --help to see the options.`;
export const scopeConflict = 'Conflicting scope: -g selects homedir but --scope says repo.';
export const scopeInvalid = (value) => `Unknown scope '${value}'. Use repo or homedir.`;

// -- repository ---------------------------------------------------------------
export const repoPrompt = 'Where should the tooling come from?';
export const repoClientLabel = 'My client repository';
export const repoSdkLabel = 'Full BlueCube SDK (BlueCube staff)';
export const repoNamePrompt = 'Client repository (owner/name)';
export const repoNamePlaceholder = 'BlueCube-AI/acme-coder';
export const repoNameInvalid = 'Enter the repository as owner/name, for example BlueCube-AI/acme-coder.';
export const repoInvalid = (value) =>
  `'${value}' is not a repository. Use owner/name, for example BlueCube-AI/acme-coder, or a git URL.`;
export const repoConflict = 'Name one repository: as the argument or with --repo.';
export const repoRequired = `No repository given. Name your client repository:

  ${NPX_COMMAND} <owner/client-repo>

BlueCube staff install the full SDK with ${NPX_COMMAND} ${SDK_REPO}.`;

// -- preflight ----------------------------------------------------------------
export const uvMissing = (command) =>
  `uv (the Python package runner) is not installed. The official install command is:\n\n  ${command}\n`;
export const uvConfirm = 'Run the uv install command now?';
export const uvDeclined = 'uv is required. Install it with the command above, open a new terminal and run the installer again.';
export const uvInstallFailed = 'The uv install command failed. Install uv by hand (https://docs.astral.sh/uv/), open a new terminal and run the installer again.';
export const uvNotOnPath = 'uv was installed but is not on PATH yet. Open a new terminal and run the installer again.';

export const gitMissing = 'git is not installed. Install git (https://git-scm.com/downloads) and run the installer again.';
const gitSaid = (stderr) => {
  const details = (stderr || '').trim().split('\n').filter(Boolean).map((line) => `    ${line}`).join('\n');
  return details ? `\n\n  git said:\n${details}` : '';
};
// The access messages name the chosen repository; a URL that names none keeps the SDK's.
const sshAlternative = (repo) =>
  `Or use SSH: set BLUECUBE_SDK_URL=git@github.com:${repo ?? SDK_REPO}.git after adding your SSH key to GitHub.`;

export const gitAccessFailed = (url, stderr, timedOut, repo) => {
  const reason = timedOut ? 'The request timed out after 30 seconds.' : 'git could not read the repository.';
  return `Cannot reach the BlueCube SDK repository at ${url}.
${reason} The repository is private, so git needs your GitHub credentials:

  gh auth login
  gh auth setup-git

${sshAlternative(repo)}${gitSaid(stderr)}`;
};
export const gitNoAccess = (url, stderr, repo) => `Cannot read the BlueCube SDK repository at ${url}.
git signed in to GitHub, but the account it used cannot see this repository. Usually git is
using another account or an old saved login, not the one that was given access:

  gh auth status       # shows the account gh is signed in with
  gh auth login        # sign in with the account that has access (gh auth switch if you have several)
  gh auth setup-git    # makes git use that login for github.com

If that is the right account, ask BlueCube for read access to ${repo ?? SDK_REPO}.
${sshAlternative(repo)}${gitSaid(stderr)}`;

// -- source -------------------------------------------------------------------
export const sourceClone = (url, slot) => `Source: git clone ${url} into ${slot}`;
export const sourceFetch = (slot) => `Source: git fetch in cached ${slot}`;
export const sourceResolved = (ref, sha) => `SDK ${ref} at ${sha.slice(0, 12)}`;
export const sourceGitFailed = (step, stderr) => `git ${step} failed:\n${(stderr || '').trim()}`;
export const sourceUnknownRef = (ref, stderr) => `The SDK has no tag, branch or commit named '${ref}'.\n${(stderr || '').trim()}`;
export const sourceBrokenSlot = (slot) => `The cached SDK at ${slot} is damaged.`;
export const sourceBrokenConfirm = 'Delete it and clone again?';
export const sourceBrokenDeclined = (slot) => `Delete ${slot} by hand and run the installer again.`;

// -- catalog ------------------------------------------------------------------
export const catalogReading = 'Reading the SDK category catalog (the first run installs its Python dependencies)...';
export const catalogTooOld = (ref) =>
  `The SDK at ref '${ref}' predates the category catalog (deploy.py --list-categories). Use a newer --ref.`;
export const catalogFailed = (stderr) => `Reading the SDK category catalog failed:\n${(stderr || '').trim()}`;
export const catalogInvalid = 'The SDK printed a category catalog the installer cannot read.';
export const catalogSchema = (found) =>
  `The SDK catalog has schemaVersion ${found}; this installer reads version 1. Update the installer (npx @bluecube-ai/coder@latest).`;

// -- client package -----------------------------------------------------------
// `fetched` is the slot's client-package.json, `installed` the target's SDK_MANIFEST.json.
export const newerPackage = (fetched, installed) =>
  `A newer version of your BlueCube Coder package is available: ${fetched.sdkVersion} `
  + `(revision ${fetched.revision}). This install has ${installed.sdk_version} `
  + `(revision ${installed.client_package.revision}).`;

// -- picker -------------------------------------------------------------------
export const harnessPrompt = 'Which coding agent should the tooling be installed for?';
export const harnessNoneDetected =
  'No supported coding agent found on PATH. Install one of: claude (Claude Code), pi, opencode (codex is not supported yet), or pass --agent.';
export const harnessUnsupportedHint = (ref) => `experimental, not supported by SDK ${ref} yet`;
export const harnessUnsupported = (name, ref) => `${name} is ${harnessUnsupportedHint(ref)}`;
export const harnessAuto = (displayName) => `Agent: ${displayName}`;
export const experimentalBadge = 'experimental';

export const scopePrompt = 'Where should it be installed?';
export const scopeRepoLabel = (dir) => `Only this project (${dir})`;
export const scopeHomedirLabel = (dir) => `Every project on this machine (${dir})`;
export const projectOnlyNotAvailable = (labels) =>
  `Not available here: ${labels.join(', ')}. Run ${NPX_COMMAND} inside a project to add them.`;

export const targetNotGit = (target) => `${target} is not a git work tree.`;
export const targetNotGitConfirm = 'Install there anyway?';

export const categoriesPrompt = 'Select what to install (space toggles, enter confirms)';
export const categoriesEmptyRetry = 'Nothing selected. Pick at least one item, or press Ctrl+C to cancel.';
export const categoriesNone = (scope, agent) => `no ${scope} categories for ${agent}`;
export const categoriesUnknown = (ids, scope, agent, valid) =>
  `Unknown category id(s) for ${agent} in ${scope} scope: ${ids.join(', ')}\nValid ids: ${valid.join(', ')}`;
export const pluginsGroup = 'Claude Code plugins';
export const projectOnlyBadge = 'this project only';

const joinNames = (names) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
export const projectOnlyRefused = (entries, scopeFlag) => {
  const names = joinNames(entries.map(({ id, label }) => `${label} (${id})`));
  const reach = scopeFlag ? `with ${scopeFlag}` : 'for every project';
  const verb = entries.length === 1 ? 'It only works' : 'They only work';
  return `${names} can't be installed ${reach}. ${verb} inside one project.
Run this inside the project instead:

  ${NPX_COMMAND} --categories ${entries.map(({ id }) => id).join(',')}

Nothing was installed.`;
};

export const cancelled = 'Cancelled.';
export const promptInNonInteractive = (question) => `A question was needed in non-interactive mode: ${question}`;

// -- deploy, plugins, report ---------------------------------------------------
export const deployFailed = (code) => `deploy.py exited with code ${code}.`;
export const pluginFailed = (command, code) => `Plugin command failed (exit ${code}): ${command}`;
export const pluginSkippedNoClaude = 'The claude CLI is not on PATH, so the plugins were not installed.';
export const pluginSkippedNoSource = (url) =>
  `The plugins were not installed: their marketplace is added from GitHub or a file:// checkout, not from ${url}.`;
const claudeWithVersion = ({ path, version }) => `${path} (${version ?? 'version unknown'})`;
export const pluginClaudeTooOld = (checked) => 'The plugins were not installed: no claude CLI found here takes '
  + `--sparse and --scope on its plugin commands. Checked: ${checked.map(claudeWithVersion).join(', ')}`;
export const legacySourceLabel = 'the local copies deploy.py registered';
export const pluginsProjectConflict = (inUse, wanted) => `Plugins not installed for this project: the `
  + `bluecube-coder plugin marketplace on this machine comes from ${inUse}, not ${wanted}. A project `
  + 'install never moves it, since that would change the plugins of every project. Run the installer '
  + 'with -g to move it.';
export const unexpectedError = (message) => `Unexpected error: ${message}`;

const pluginList = (carried) => carried.map(({ name, scope }) => `${name} (${scope})`).join(', ') || 'no enabled plugins';
export const migrationDetected = (reason, carried) => (reason === 'legacy'
  ? `Legacy plugin registration found: ${pluginList(carried)}; it will be replaced by the GitHub marketplace`
  : `Plugin marketplace source will change: ${pluginList(carried)} will be reinstalled`);
// The claude CLI cannot see a legacy registration, so it cannot uninstall from one either.
export const pluginsNotOffered = (source, entries, reason) => {
  const names = [...new Set(entries.map(({ name }) => name))];
  const them = names.length === 1 ? 'it' : 'them';
  const uninstall = entries
    .map(({ name, scope }) => `claude plugin uninstall ${name}@bluecube-coder --scope ${scope}`)
    .join(' and ');
  const hint = reason === 'legacy' ? '' : ` To move anyway, uninstall ${them} first: ${uninstall}`;
  return `Plugins left unchanged: ${source} does not offer ${joinNames(names)}, and moving the `
    + `bluecube-coder marketplace there would remove ${them}.${hint}`;
};
export const migrated = (count) =>
  `Migrated ${count} ${count === 1 ? 'plugin' : 'plugins'} from a local checkout to the GitHub marketplace`;
export const migrationRolledBack = (command, code) =>
  `Plugin migration rolled back, plugins unchanged: ${command} exited with code ${code}`;
export const migrationPending = 'Run the installer again once `claude` is on PATH and up to date '
  + '(`claude update`): the bluecube-coder plugin marketplace has to move first, and a claude '
  + 'command typed by hand cannot move it';
export const pluginsLocalSource = (checkout) =>
  `Plugins load from the local checkout at ${checkout}; this machine is off the pinned release`;
export const pluginsUpdated = (names) => `Updated to the pinned release: ${names.join(', ')}`;
export const pluginsAhead = (entries) => `Ahead of the pinned release, left as is: ${entries
  .map(({ name, version, pinned }) => `${name} ${version} (pinned ${pinned})`).join(', ')}`;

export const installedHere = (dir) => `Installed for this project (${dir}):`;
export const installedEverywhere = (dir) => `Installed for every project (${dir}):`;
export const nextStepsHeading = 'Next steps';
export const nextStepSession = (displayName) => `Start a new ${displayName} session to load the new commands`;
export const nextStepHooks = (settingsPath) => `Review the hooks under ${settingsPath} before you trust them`;
export const nextStepUpdateClaude = 'Update Claude Code with `claude update`, or remove the old copy named above, '
  + 'then run the plugin commands below';
export const nextStepPlugin = (command) => `Run by hand: ${command}`;
