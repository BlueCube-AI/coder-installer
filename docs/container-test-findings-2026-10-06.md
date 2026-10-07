# Container test findings: @bluecube-ai/coder 1.1.0

Date: 2026-10-06. Installer 1.1.0 (published), SDK pinned at `v1.0.0` (`4b32f52`), Claude Code 2.1.291,
Node 22, Debian bookworm containers on Docker Desktop.

## Summary

| # | Finding | Where | Severity |
|---|---------|-------|----------|
| 1 | A home install writes status line and damage-control paths relative to the project, so they break in every project without its own repo install | SDK `deployer.py` (headless `--mode homedir`) | High |
| 2 | When `curl` is missing, the uv install "succeeds" and the installer says uv is not on PATH | Installer `src/preflight.js` | Medium |
| 3 | Without a TTY and without `--yes`, the installer draws a prompt and exits 0 having done nothing | Installer `src/cli.js` / prompts | Medium |
| 4 | A repo-scope run adds a second, project-scope install of a plugin that is already installed at user scope | Installer `src/plugins.js` | Low |
| 5 | The plugin marketplace follows the SDK's `main` branch, not the pinned `bluecube.sdkRef` | Installer `src/plugins.js` | Low today, latent |
| 6 | Headless `deploy.py -n` silently ignores plugin category ids | SDK `deploy.py` | Low |
| 7 | `npx @bluecube-ai/coder` inside this repo fails with `bluecube-coder: command not found` | npm behaviour | Info |
| 8 | Plugin versions are declared in both `plugin.json` and `marketplace.json` | SDK | Info |

The deploy.py and npx marketplace interop (legacy migration, source switching, rerun behaviour)
works as the spec describes. See [Verified behaviour](#verified-behaviour).

## 1. Home install writes project-relative paths (SDK)

**Symptom.** After `npx @bluecube-ai/coder -g`, a new Claude Code session shows no status line.

**What gets written** to `~/.claude/settings.json`:

```
statusLine:  uv run "$CLAUDE_PROJECT_DIR"/.claude/status_lines/status_line.py
PreToolUse:  "$CLAUDE_PROJECT_DIR"/.claude/skills/damage-control/hooks/damage-control.sh --tool bash|read|edit|write
```

The files are deployed to `~/.claude/...`, but `$CLAUDE_PROJECT_DIR` is the project the session
starts in. The commands only resolve in `~` itself or in a project that has its own repo install
(which then runs the repo's copy, not the home one). Everywhere else:

- The status line fails: `error: Failed to spawn: <project>/.claude/status_lines/status_line.py`.
- The damage-control hooks fail to start. Claude Code treats that as a non-blocking hook error and
  the tool call proceeds, so damage-control is silently off while settings say it is on.

On the test machine every project under `~/VSC` except `coder-installer` had a repo install, which
hid the problem. A user who only runs `npx -g` is affected in every project.

**Cause.** The two `deploy.py` home-install paths use different deployers:

| | Web UI home install | Headless `deploy.py -n --mode homedir` (what `npx -g` runs) |
|---|---|---|
| Deployer | `homedir_deployer.deploy_all` | `deployer.deploy_all` (the repo deployer) |
| `statusLine` in `~/.claude/settings.json` | not written | `"$CLAUDE_PROJECT_DIR"/...` |
| damage-control hooks | not written | 4 hooks with `"$CLAUDE_PROJECT_DIR"/...` |
| `~/.claude/status_lines/status_line.py` | not deployed | deployed |
| `SDK_MANIFEST.json` `deployment_type` | `homedir` | `repo` |

Identical results at SDK `v1.0.0` and at `6bcb18b` (the last commit before the npx work).
`create_default_settings` in `sdk/deploy_modules/deployer.py` (around lines 1905 to 1975 at `v1.0.0`)
hardcodes `'"$CLAUDE_PROJECT_DIR"/.claude/...'` and has no mode parameter; `sync.py:117-140` has
the same strings.

**Pre-existing or new.** The bug has been in the headless home path since `sdk/deploy.py` was added
(`5589496`, 2026-04-28). The npx installer (`a2b5b5a`, 2026-09-30) exposed it: it sends every home
install through the headless path, and the catalog offers `status_line` and `damage_control` as
defaults for the home scope (unchanged since April).

**Fix options (SDK).**

1. Recommended: in home mode, write `"$HOME"/.claude/...` (`%USERPROFILE%` in the Windows variant) for
   `statusLine` and every hook, and record `deployment_type: homedir`.
2. Route headless home installs to `homedir_deployer`. That matches the web UI, but home installs then
   get no status line or hooks, and the catalog must stop offering them for the home scope.

Either way, the installer's integration test should assert on the contents of
`~/.claude/settings.json` after a `-g` run.

**Workaround.** In `~/.claude/settings.json`, replace `"$CLAUDE_PROJECT_DIR"/.claude` with
`"$HOME"/.claude` in `statusLine` and the damage-control hooks. In projects that also have a repo
install, damage-control then runs twice per tool call (harmless).

## 2. uv install "succeeds" without curl (installer)

**Repro.** `node:22-bookworm-slim` has no `curl`, `wget` or `git`, and `/bin/sh` is dash.

```
$ npx @bluecube-ai/coder -g
uv (the Python package runner) is not installed. The official install command is:
  curl -LsSf https://astral.sh/uv/install.sh | sh
◇  Run the uv install command now?  Yes
/usr/bin/sh: 1: curl: not found
uv was installed but is not on PATH yet. Open a new terminal and run the installer again.
(exit 2)
```

**Cause.** `src/preflight.js:14` runs `sh -c 'curl ... | sh'`. A pipeline's exit status is that of
its last command: the second `sh` reads empty input and exits 0, so `result.code` is 0 and the
check at `src/preflight.js:36` passes. uv is then missing from `~/.local/bin`, and line 42 prints
`uvNotOnPath`. The exit code (2) is right; the message is wrong, and "open a new terminal" cannot
help.

**Fix options.**

- Check for `curl` (or fall back to `wget -qO- https://astral.sh/uv/install.sh | sh`, the other
  official form) before offering the install, and say which tool is missing.
- Or download first, then run, so a failed download fails the command:
  `curl -LsSf https://astral.sh/uv/install.sh -o <tmp> && sh <tmp>`. `set -o pipefail` is not an
  option because dash does not support it on every distribution.
- Only print `uvNotOnPath` when uv exists in one of the install directories; otherwise report
  `uvInstallFailed`.

**Related prerequisite gap.** The same slim image also lacks `git`. With `curl` and `git` installed
(`apt-get install -y curl git`), uv installs correctly and the run stops at the git access check with
the clear "repository is private" message. The README prerequisites do not mention `git` or `curl`.

## 3. Prompt without a TTY exits 0 (installer)

**Repro.** Run the installer with stdin not a terminal and without `--yes`:

```
$ npx @bluecube-ai/coder --agent claude-code --scope repo --categories git </dev/null
◆  Run the uv install command now?
│  ● Yes / ○ No
(exit 0, nothing installed)
```

**Cause.** Non-interactive mode only turns on when `--yes`, `--agent`, `--scope` and `--categories`
are all given (`src/cli.js:77`). Otherwise the clack prompt reads an empty stdin and the process ends
quietly with 0. A CI job that forgets `--yes` would show as passing without installing anything.

**Fix.** When stdin is not a TTY and a prompt is needed, fail with exit 2 and name the missing flag
(or exit 130 if the prompt was cancelled).

## 4. Duplicate plugin install at user and project scope (installer)

**Repro (scenario E).** `bluecube-sdlc` installed at repo scope in two repos, then deploy.py's web UI
(home) on top, then `npx --scope repo --categories git,plugin:bluecube-sdlc` twice in one repo.

| Run | `installed_plugins.json` for `bluecube-sdlc` |
|---|---|
| deploy.py web UI | One user-scope entry (both project entries replaced) |
| npx, 1st (migration) | User scope only. Correct per REQ-04 |
| npx, 2nd (same command) | User scope **and** a new project-scope entry for that repo |

**Cause.** The migration run carries the user scope (`src/plugins.js:67`). The next run takes the
normal path, which only checks whether the plugin is installed at the run's scope
(`src/plugins.js:105-106`), so it adds a project install. The same happens without deploy.py:
`npx -g` with a plugin, then `npx --scope repo` with the same plugin.

**Fix options.** Treat a user-scope install as covering repo runs and skip the project install
(consistent with REQ-04; reruns settle on one install), or keep the behaviour and document it.

## 5. Marketplace tracks `main`, not the pinned SDK tag (installer)

The installer runs `claude plugin marketplace add BlueCube-AI/bluecube-coder --sparse ...` with no
ref, so Claude Code clones the default branch. Deployed files come from `bluecube.sdkRef`
(`v1.0.0`). Today `main` and `v1.0.0` are the same commit, so nothing differs. Once `main` moves,
npx users get plugins from `main`, and the "ahead of the pinned release" report starts firing.

Claude Code supports `owner/repo#<ref>` on `marketplace add`. Pinning to `#<sdkRef>` means a pin
change becomes a source change the installer has to handle (like the GitHub and local-checkout
switch), so `sourceMatches` would also need to compare the ref.

## 6. Headless deploy.py ignores plugin categories (SDK)

`uv run sdk/deploy.py -n --mode homedir --categories git,bluecube_sdlc_plugin,kb_knowledge_graph_plugin`
deploys `git`, exits 0, and installs no plugins, without a warning. Only the web UI backend
(`POST /api/deploy`) calls `_register_plugin`. A warning for categories the headless path does not
deploy would prevent the false success.

## 7. npx inside this repo (npm behaviour)

```
coder-installer$ npx @bluecube-ai/coder           -> sh: bluecube-coder: command not found
coder-installer$ npx @bluecube-ai/coder@1.1.0     -> same
coder-installer$ npx @bluecube-ai/coder@latest    -> works
any other folder$ npx @bluecube-ai/coder          -> works
```

npm sees that the current project's `package.json` is `@bluecube-ai/coder@1.1.0`, treats the
package as already present, and looks for `bluecube-coder` in `./node_modules/.bin`, where a
package is never linked into itself. Users are not affected. Inside the repo, use
`npx @bluecube-ai/coder@latest` for the published package or `node bin/coder.js` for local source.
Worth one line in the README's Development section.

## 8. Plugin version declared twice (SDK)

`kb-knowledge-graph` (0.7.2) and `bluecube-sdlc` (1.1.1) set `version` in both their `plugin.json`
and their `marketplace.json` entry. The Claude Code docs advise one place only: if they differ,
`plugin.json` wins without a warning and `claude plugin validate` reports the mismatch. They
match today.

## Verified behaviour

All runs used the published `npx @bluecube-ai/coder@latest` (1.1.0) in fresh containers. "Old-style"
means the inline `settings` marketplace that deploy.py's web UI writes, with plugins pointing at
`file://~/.claude/plugins/<name>` copies.

| Scenario | Result |
|---|---|
| A. deploy.py web UI, then `npx -g`, then `npx -g` again | Migrated to the GitHub marketplace ("Migrated 2 plugins..."), local copies deleted, exit 0. The rerun runs no plugin commands |
| B. `npx -g`, then deploy.py web UI, then `npx -g` | deploy.py switches the source back to its local copies; the next npx run migrates to GitHub again. Matches the spec ("latest install wins") |
| C. deploy.py web UI, then `npx --scope repo` with `plugin:bluecube-sdlc` | Migrated; plugins keep user scope, no project install (REQ-04) |
| D. `npx -g`, then with `BLUECUBE_SDK_URL=file:///opt/sdk`, again, then plain `npx -g` | Source becomes the `directory` `/opt/sdk` with the "off the pinned release" line, stays on rerun, switches back to GitHub silently (REQ-11) |
| E. Repo installs in two repos, deploy.py, npx twice | See finding 4 |
| No uv, `node:22-bookworm` (has curl) | `--yes` installs uv and continues; exit 0 |
| No uv, slim image (no curl) | See finding 2 |

The source in `settings.json` always ended as the most recent installer's: GitHub after npx, the local
copies after deploy.py, the checkout folder after a `file://` npx run.

## Not verified

- **Whether a live Claude Code session loads the plugins after deploy.py.** Whenever the old-style
  registration is active, `claude plugin list` shows "failed to load: Marketplace bluecube-coder not
  found". The spec describes the same CLI behaviour for legacy installs. Checking a live session
  needs a logged-in Claude Code.
- **Old-style repo-scope registrations from SDKs before v1.0.0.** In v1.0.0 the plugin categories
  are home-only.
- **The migration rollback with a real failing `claude` command.** Covered by unit tests only.
- **The Windows uv install path.**

## How to reproduce

Test image:

```dockerfile
FROM node:22-bookworm
ENV npm_config_update_notifier=false
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
RUN npm i -g @anthropic-ai/claude-code
# Read the private SDK with a token passed at run time
RUN git config --system credential.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
```

```bash
docker build -t bc-interop .
docker run -it --rm -e GH_TOKEN="$(gh auth token)" bc-interop bash
```

`GH_TOKEN` alone does not authenticate git (or Claude Code's marketplace clone); it needs the
credential helper line above, or `gh auth setup-git`.

Create the old-style deploy.py registration (headless deploy.py cannot do it, see finding 6):

```bash
git clone https://github.com/BlueCube-AI/bluecube-coder.git /opt/sdk && cd /opt/sdk && git checkout v1.0.0
uv run sdk/deploy.py --no-browser --port 8765 &
id=$(curl -s -X POST localhost:8765/api/deploy -H 'content-type: application/json' \
  -d "{\"mode\":\"homedir\",\"path\":\"$HOME\",\"agent\":\"claude-code\",\"selected\":[\"bluecube_sdlc_plugin_root\",\"kb_plugin_root\"]}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).deployId')
curl -sN "localhost:8765/api/deploy/$id/events"
```

Run the installer from a project folder, not from this repo (finding 7):

```bash
mkdir -p /work/demo && cd /work/demo && git init
npx --yes @bluecube-ai/coder@latest -g --agent claude-code \
  --categories git,plugin:bluecube-sdlc,plugin:kb-knowledge-graph --yes
```

Inspect the result in `~/.claude/settings.json` (`extraKnownMarketplaces`, `enabledPlugins`,
`statusLine`, `hooks`), `~/.claude/plugins/known_marketplaces.json`,
`~/.claude/plugins/installed_plugins.json`, `claude plugin marketplace list` and
`claude plugin list`.
