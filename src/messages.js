// Every sentence the installer shows to a user lives here, so wording can be
// reviewed in one place and tests can assert on the exact text.

export const MARKETPLACE_REPO = 'BlueCube-AI/bluecube-coder';

export const usage = (name) => `Usage: ${name} [options]

Install BlueCube Coder tooling from a pinned SDK release.

Options:
  -g, --global            Install into your home directory (same as --scope homedir)
      --scope <scope>     repo (default target: current directory) or homedir
      --agent <name>      claude-code, pi or opencode
      --categories <ids>  Comma-separated category ids (skips the picker)
      --ref <ref>         SDK tag, branch or commit (default: the pinned ref)
      --target <path>     Install target directory
  -y, --yes               Answer yes to every confirmation
      --dry-run           Print the deploy and plugin commands without running them
  -h, --help              Show this help
      --version           Show the installer version

With --agent, --scope (or -g), --categories and --yes no question is asked.

Exit codes: 0 success, 1 deploy failed, 2 preflight failed,
            3 unsupported harness, 130 cancelled.

Environment:
  BLUECUBE_SDK_URL    Git URL of the SDK (default: the BlueCube repository)
  BLUECUBE_CACHE_DIR  Source cache (default: ~/.bluecube/cache/sources)
  DEBUG               Print stack traces for unexpected errors`;

export const intro = (version) => `BlueCube Coder installer ${version}`;

// -- flags --------------------------------------------------------------------
export const flagError = (detail) => `${detail}\nRun with --help to see the options.`;
export const scopeConflict = 'Conflicting scope: -g selects homedir but --scope says repo.';
export const scopeInvalid = (value) => `Unknown scope '${value}'. Use repo or homedir.`;

// -- preflight ----------------------------------------------------------------
export const uvMissing = (command) =>
  `uv (the Python package runner) is not installed. The official install command is:\n\n  ${command}\n`;
export const uvConfirm = 'Run the uv install command now?';
export const uvDeclined = 'uv is required. Install it with the command above, open a new terminal and run the installer again.';
export const uvInstallFailed = 'The uv install command failed. Install uv by hand (https://docs.astral.sh/uv/), open a new terminal and run the installer again.';
export const uvNotOnPath = 'uv was installed but is not on PATH yet. Open a new terminal and run the installer again.';

export const gitMissing = 'git is not installed. Install git (https://git-scm.com/downloads) and run the installer again.';
export const gitAccessFailed = (url, stderr, timedOut) => {
  const reason = timedOut ? 'The request timed out after 30 seconds.' : 'git could not read the repository.';
  const details = (stderr || '').trim().split('\n').filter(Boolean).map((line) => `    ${line}`).join('\n');
  return `Cannot reach the BlueCube SDK repository at ${url}.
${reason} The repository is private, so git needs your GitHub credentials:

  gh auth login
  gh auth setup-git

Or use SSH: set BLUECUBE_SDK_URL=git@github.com:${MARKETPLACE_REPO}.git after adding your SSH key to GitHub.${details ? `\n\n  git said:\n${details}` : ''}`;
};

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

// -- picker -------------------------------------------------------------------
export const harnessPrompt = 'Which coding agent should the tooling be installed for?';
export const harnessNoneDetected =
  'No supported coding agent found on PATH. Install one of: claude (Claude Code), pi, opencode (codex is not supported yet), or pass --agent.';
export const harnessUnsupportedHint = (ref) => `experimental, not supported by SDK ${ref} yet`;
export const harnessUnsupported = (name, ref) => `${name} is ${harnessUnsupportedHint(ref)}`;
export const harnessAuto = (displayName) => `Agent: ${displayName}`;
export const experimentalBadge = 'experimental';

export const scopePrompt = 'Where should it be installed?';
export const scopeRepoLabel = 'This project';
export const scopeRepoHint = (cwd) => `current directory: ${cwd}`;
export const scopeHomedirLabel = 'Home directory';
export const scopeHomedirHint = 'available in every project';

export const targetNotGit = (target) => `${target} is not a git work tree.`;
export const targetNotGitConfirm = 'Install there anyway?';

export const categoriesPrompt = 'Select what to install (space toggles, enter confirms)';
export const categoriesEmptyRetry = 'Nothing selected. Pick at least one item, or press Ctrl+C to cancel.';
export const categoriesNone = (scope, agent) => `no ${scope} categories for ${agent}`;
export const categoriesUnknown = (ids, scope, agent, valid) =>
  `Unknown category id(s) for ${agent} in ${scope} scope: ${ids.join(', ')}\nValid ids: ${valid.join(', ')}`;
export const pluginsGroup = 'Claude Code plugins';

export const cancelled = 'Cancelled.';
export const promptInNonInteractive = (question) => `A question was needed in non-interactive mode: ${question}`;

// -- deploy, plugins, report ---------------------------------------------------
export const deployFailed = (code) => `deploy.py exited with code ${code}.`;
export const pluginFailed = (command, code) => `Plugin command failed (exit ${code}): ${command}`;
export const pluginSkippedNoClaude = 'The claude CLI is not on PATH, so the plugins were not installed.';
export const unexpectedError = (message) => `Unexpected error: ${message}`;

export const nextStepsHeading = 'Next steps';
export const nextStepSession = (displayName) => `Start a new ${displayName} session to load the new commands`;
export const nextStepHooks = (settingsPath) => `Review the hooks under ${settingsPath} before you trust them`;
export const nextStepPlugin = (command) => `Run by hand: ${command}`;
