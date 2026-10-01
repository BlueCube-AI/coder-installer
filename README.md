# @bluecube-ai/coder

Installs BlueCube Coder tooling (commands, agents, hooks, skills and Claude Code plugins) into a
project or your home directory for Claude Code, Pi or OpenCode.

The package carries no tooling content. It downloads a pinned release of the private BlueCube
Coder SDK with your git credentials, reads the list of installable categories from it, and runs
the SDK's own deploy script.

## Prerequisites

- Node.js 20 or later.
- Read access to `github.com/BlueCube-AI/bluecube-coder`. The installer probes it with
  `git ls-remote` and never asks for a password. If the probe fails, sign in once:

  ```
  gh auth login
  gh auth setup-git
  ```

  or use SSH with `BLUECUBE_SDK_URL=git@github.com:BlueCube-AI/bluecube-coder.git`.
- [uv](https://docs.astral.sh/uv/). When it is missing the installer prints the official install
  command and offers to run it.
- At least one of `claude`, `pi` or `opencode` on `PATH` (or pass `--agent`). `codex` is detected
  but not supported yet.

## Usage

```
npx @bluecube-ai/coder                  # pick agent, scope and categories interactively
npx @bluecube-ai/coder -g               # install into your home directory
npx @bluecube-ai/coder --agent claude-code --scope repo --categories git,context --yes
```

The last form asks no question and is meant for CI and containers.

| Flag | Meaning |
|------|---------|
| `-g`, `--global` | Install into the home directory (same as `--scope homedir`) |
| `--scope <repo\|homedir>` | `repo` installs into `--target` or the current directory |
| `--agent <name>` | `claude-code`, `pi` or `opencode` |
| `--categories <a,b>` | Category ids, plus `plugin:<name>` for Claude Code plugins |
| `--ref <ref>` | SDK tag, branch or commit (default: `bluecube.sdkRef` in `package.json`) |
| `--target <path>` | Install target directory |
| `-y`, `--yes` | Answer yes to every confirmation |
| `--dry-run` | Resolve the SDK and print the deploy and plugin commands without running them |

`uv run sdk/deploy.py --list-categories --agent <name>` in an SDK checkout lists the category ids.

Claude Code plugins (`kb-knowledge-graph`, `bluecube-sdlc`) install through the `claude` CLI:
`claude plugin marketplace add BlueCube-AI/bluecube-coder --sparse .claude-plugin plugins`, then
`claude plugin install <name>@bluecube-coder --scope project` (or `--scope user` with `-g`).

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (also when no category exists for the chosen agent and scope) |
| 1 | The deploy failed |
| 2 | Preflight failed: uv, git access, unknown ref, unknown category id or bad flag |
| 3 | The chosen agent is not supported by the pinned SDK |
| 130 | Cancelled |

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `BLUECUBE_SDK_URL` | `bluecube.sdkRepo` in `package.json` | Git URL of the SDK; maintainers point it at a `file://` checkout |
| `BLUECUBE_CACHE_DIR` | `~/.bluecube/cache/sources` | Source cache; one slot per URL, shared with the SDK's source resolver |
| `DEBUG` | unset | Print stack traces for unexpected errors |

The SDK is cloned once into `<cache>/<first 16 hex of sha256(url)>`, fetched on later runs,
checked out detached at the resolved commit, and recorded in `source.json` in the slot.

## Development

```
npm ci
npm test                                   # unit tests, offline
BLUECUBE_INSTALLER_INTEGRATION=1 BLUECUBE_SDK_URL=file:///path/to/your/bluecube-coder npm run test:integration
```

The integration test needs a local checkout of the private SDK (read access to
`BlueCube-AI/bluecube-coder`). It clones the committed `HEAD` of that checkout, so commit SDK
changes first. The SDK repository also runs this test in its own CI against every change.

## Release

Releases are published from GitHub Actions with npm trusted publishing: no stored token, and
npm adds a provenance statement that links the package to the exact commit and workflow run.
Only repository admins can push `v*` tags, and every publish waits for approval in the `npm`
environment.

1. Open a pull request that bumps `version`, and `bluecube.sdkRef` when the SDK has a new tag.
   Merge it.
2. `git switch main && git pull && git tag v<version> && git push origin v<version>`
3. In Actions, open the run for the tag, choose Review deployments and approve `npm`.
4. Check `npm view @bluecube-ai/coder version`.

The first version was published by hand, because npm only offers trusted publishing for a
package that already exists.
