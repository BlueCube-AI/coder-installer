# @bluecube-ai/coder

Installs BlueCube Coder tooling (commands, agents, hooks, skills and Claude Code plugins) into a
project or your home directory for Claude Code, Pi or OpenCode.

The package carries no tooling content. It downloads your client repository (or, for BlueCube
staff, a pinned release of the private BlueCube Coder SDK) with your git credentials, reads the
list of installable categories from it, and runs the SDK's own deploy script.

## Prerequisites

- Node.js 20 or later.
- Read access to your client repository, for example `github.com/BlueCube-AI/acme-coder` (BlueCube
  staff: `github.com/BlueCube-AI/bluecube-coder`). The installer probes it with `git ls-remote`
  and never asks for a password. If the probe fails, sign in once:

  ```
  gh auth login
  gh auth setup-git
  ```

  or use SSH with `BLUECUBE_SDK_URL=git@github.com:BlueCube-AI/acme-coder.git`. When the account
  git uses cannot see the repository, the installer names it so you can ask BlueCube for access.
- [uv](https://docs.astral.sh/uv/). When it is missing the installer prints the official install
  command and offers to run it.
- At least one of `claude`, `pi` or `opencode` on `PATH` (or pass `--agent`). `codex` is detected
  but not supported yet.

## Usage

```
npx @bluecube-ai/coder BlueCube-AI/acme-coder      # install from your client repository
npx @bluecube-ai/coder BlueCube-AI/acme-coder -g   # install into your home directory
npx @bluecube-ai/coder                             # ask for the repository first
npx @bluecube-ai/coder BlueCube-AI/acme-coder --agent claude-code --scope repo --categories git,context --yes
npx @bluecube-ai/coder BlueCube-AI/bluecube-coder  # BlueCube staff: the full SDK at the pinned release
```

Replace `BlueCube-AI/acme-coder` with the repository BlueCube gave you. The installer accepts
`owner/name` or a git URL, as the argument or with `--repo`. A client repository installs from
its `main` branch; `BlueCube-AI/bluecube-coder` installs the pinned SDK release.

Without a repository an interactive run asks where the tooling comes from: "My client
repository" (then the repository as `owner/name`) or "Full BlueCube SDK (BlueCube staff)".

The fourth form asks no question and is meant for CI and containers. A run with `--agent`,
`--scope` (or `-g`), `--categories` and `--yes` but no repository exits 2 and prints the command
to run with your repository. `BLUECUBE_SDK_URL` counts as a repository.

| Flag | Meaning |
|------|---------|
| `<owner/repo>`, `--repo <repo>` | Repository to install from: `owner/name` or a git URL |
| `-g`, `--global` | Install into the home directory (same as `--scope homedir`) |
| `--scope <repo\|homedir>` | `repo` installs into `--target` or the current directory |
| `--agent <name>` | `claude-code`, `pi` or `opencode` |
| `--categories <a,b>` | Category ids, plus `plugin:<name>` for Claude Code plugins |
| `--ref <ref>` | Tag, branch or commit (default: `main` for a client repository; `bluecube.sdkRef` in `package.json` for `BlueCube-AI/bluecube-coder` and for any URL that names no GitHub repository, `file://` included) |
| `--target <path>` | Install target directory |
| `-y`, `--yes` | Answer yes to every confirmation |
| `--dry-run` | Resolve the SDK and print the deploy and plugin commands without running them |

`uv run sdk/deploy.py --list-categories --agent <name>` in an SDK checkout lists the category ids.

Claude Code plugins (`kb-knowledge-graph`, `bluecube-sdlc`) install through the `claude` CLI
when you pick at least one, at the scope of the run:

- A home run (`-g`) runs `claude plugin marketplace add <owner/repo> --sparse .claude-plugin plugins`
  for the repository you install from, then `claude plugin install <name>@bluecube-coder --scope user`,
  so each plugin is available in every project.
- A repo run adds `--scope project` to both. The marketplace and the plugins are declared in the
  project's `.claude/settings.json` and work in that project only, and teammates who open the
  project are offered the same plugins. Plugins installed for every project are left alone.

A plugin already installed at the run's scope is updated, never installed again. A run that picks
no plugin leaves the plugins and their marketplace exactly as they are.

Claude Code keeps one `bluecube-coder` marketplace per machine. When it already comes from another
source, such as the full SDK on a staff machine, a repo run installs no plugin and names the source
in use: moving the marketplace would change the plugins of every project. A home run moves it, as
described below.

Older Claude Code releases lack `--sparse` or `--scope`. The installer checks every `claude` it can
find, those on `PATH` in order and then `~/.local/bin/claude` and `~/.claude/local/claude`, and uses
the first one that has both. `npx` puts the `node_modules/.bin` of every parent folder ahead of
`PATH`, and a shell alias is invisible to it, so the first `claude` it sees can be an old copy your
shell never runs. When none has them, the installer installs everything else, names each `claude`
it checked with its version, and asks you to update or remove the old copy and then run the plugin
commands it prints.

A machine where the SDK's `deploy.py` registered the plugins from local copies carries a legacy
`bluecube-coder` marketplace that blocks the GitHub one, so a home run replaces that registration
with the GitHub marketplace without asking. Every plugin is reinstalled at user scope, so it is
available in every project, and the leftover local copies are deleted. If any
`claude` command of that move fails, the plugin registry files and Claude Code's copy of the
marketplace are restored as they were, the report names the failing command and the installer
exits 1. When `claude` is missing or too old for such a move, the report asks you to run the
installer again once it is fixed: `claude plugin marketplace add` typed by hand is refused while
the settings still declare the old source.

Rerunning the installer updates the plugins that are behind the pinned release and names them,
and with `BLUECUBE_SDK_URL=file://...` the plugins load from that checkout instead of GitHub.
The marketplace is always named `bluecube-coder`, so a home run that moves a machine between the
full SDK and a client repository reinstalls its plugins from the new source the same way. When the new source
does not offer a plugin installed from the old one, such as `bluecube-gauntlet` on a move to a
client repository, the move would lose it: the installer leaves the plugins as they are, names
that plugin and the command to uninstall it. For a URL that is neither GitHub nor `file://` the
installer has no marketplace to add: it skips the plugins and says so.

## Client packages

A client repository holds a client package: only the items BlueCube picked for that client, and
a `client-package.json` with the package version and revision.

- The picker lists only the package's categories and plugins. A repo run starts with every
  category selected except Notifications & TTS, which you pick yourself, and no plugin; a plugin
  you pick there installs for that project only. A home run (`-g`) starts with every plugin
  selected and no category.
- When the install target holds an older package, the run says so before it installs the new
  one: "A newer version of your BlueCube Coder package is available: 1.2.0 (revision 1). This
  install has 1.1.0 (revision 3)." Running the installer again is the upgrade.
- An item BlueCube removes from your package stays installed, and it gets no more updates. The
  installer never removes files.

## What goes where

- A repo run writes to `<project>/.claude` and works in that project only.
- A home run (`-g`) writes to `~/.claude` and is available in every project.
- Plugins follow the run: a home run installs them for every project, a repo run for that project
  only, declared in its `.claude/settings.json`.
- Some entries work inside one project only. The installer reads them from the SDK catalog; with
  SDK 1.1.0 they are Project Memory, Status Line, Notifications & TTS, Session Logger and Damage
  Control. A home run leaves them out and says so, and asking for one with `-g` installs nothing
  and exits 2.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (also when no category exists for the chosen agent and scope) |
| 1 | The deploy failed, or the plugin migration was rolled back |
| 2 | Preflight failed: no repository in a non-interactive run, uv, git access, unknown ref, unknown category id, a project-only category id with -g, or bad flag or repository |
| 3 | The chosen agent is not supported by the pinned SDK |
| 130 | Cancelled |

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `BLUECUBE_SDK_URL` | unset | Git URL to install from. It replaces the URL of the chosen repository and counts as a repository on its own; use it for SSH, and maintainers point it at a `file://` checkout. The default ref follows the URL: `main` for a GitHub client repository, the pinned ref otherwise |
| `BLUECUBE_CACHE_DIR` | `~/.bluecube/cache/sources` | Source cache; one slot per URL, shared with the SDK's source resolver |
| `DEBUG` | unset | Print stack traces for unexpected errors |

The repository is cloned once into `<cache>/<first 16 hex of sha256(url)>`, fetched on later runs,
checked out detached at the resolved commit, and recorded in `source.json` in the slot.

## Development

```
npm ci
npm test                                   # unit tests, offline
BLUECUBE_INSTALLER_INTEGRATION=1 BLUECUBE_SDK_URL=file:///path/to/your/bluecube-coder npm run test:integration
BLUECUBE_INSTALLER_INTEGRATION=1 BLUECUBE_INSTALLER_CLIENT_PACKAGE=1 BLUECUBE_SDK_URL=file:///path/to/pkg npm run test:integration
```

The integration test needs a local checkout of the private SDK (read access to
`BlueCube-AI/bluecube-coder`). It clones the committed `HEAD` of that checkout, so commit SDK
changes first. The SDK repository also runs this test in its own CI against every change.

With `BLUECUBE_INSTALLER_CLIENT_PACKAGE=1` the integration test runs against a client package
instead. The URL must point at a git repository built with the SDK's `distribute.py build` from
the fixture client `sample-a`: on `main`, a first commit with the entries `context`, `git` and
`release_notes` (revision 1), which a branch named `previous` points at, then a second commit
that republishes the same SDK version without `release_notes` (revision 2). The SDK's
`installer-compat` workflow builds that repository and runs this mode.

## Release

The installer has its own version. `bluecube.sdkRef` in `package.json` pins the SDK tag it
installs, so the installer can release without an SDK release, and an SDK release reaches users
only when the installer moves its pin. The SDK's `installer-compat` workflow runs this installer's
integration test against every SDK change, which keeps the two compatible.

- A change to the installer alone bumps `version` and keeps `bluecube.sdkRef`.
- Moving `bluecube.sdkRef` to a newer SDK tag is an installer release too: a patch, or a minor
  when the new SDK adds categories or plugins.
- A breaking change to the installer's flags or exit codes moves it to the next major version.

Releases are published from GitHub Actions with npm trusted publishing: no stored token, and
npm adds a provenance statement that links the package to the exact commit and workflow run.
Pushing a `v*` tag starts the publish; if the `npm` environment has a required reviewer, the
publish waits for that approval.

1. When the release moves the pin, release the SDK first: its tag must exist before the
   installer points at it.
2. Open a pull request that sets `version` with `npm version X.Y.Z --no-git-tag-version` (which
   also updates `package-lock.json`) and, when the pin moves, `bluecube.sdkRef` to the new SDK
   tag. Update `CHANGELOG.md` with the release notes. Merge it.
3. `git switch main && git pull && git tag vX.Y.Z && git push origin vX.Y.Z`. CI refuses a tag
   that does not match `package.json`.
4. If the `npm` environment has a required reviewer, open the run for the tag in Actions,
   choose Review deployments and approve `npm`.
5. Check `npm view @bluecube-ai/coder version`, and that
   `npx @bluecube-ai/coder@latest BlueCube-AI/bluecube-coder --dry-run --agent claude-code --scope repo --categories git --yes`
   prints `SDK <bluecube.sdkRef> at <sha>`.

Version 0.1.0 was published by hand, because npm only offers trusted publishing for a package
that already exists. It follows the SDK's `main` branch instead of a tag.
