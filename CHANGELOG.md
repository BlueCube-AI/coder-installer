# Changelog

All notable changes to the BlueCube Coder installer (`@bluecube-ai/coder`) are documented in this
file. The SDK has its own changelog.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.2.0] - 2026-10-07

### Changed
- The SDK pin moves to `v1.1.0`.
- Plugins install at user scope on every run, so each plugin is installed once for every project.
  A repo run no longer adds a second, project-scope copy of a plugin that is already installed.
- The scope prompt names the folder each choice writes to: "Only this project (<project>/.claude)"
  and "Every project on this machine (~/.claude)".
- Entries that work inside one project only carry a "this project only" tag on repo runs. A home
  run names the ones it left out and the command to add them.

### Added
- The seven skills from SDK 1.1.0 (Skill Creator, Plugin Creator, Git Activity Analysis, Release
  Notes, BlueCube DOCX Style, BlueCube PPTX Style, BlueCube XLSX Style) and its three Creation
  Tools (Prompt & Agent Builder, Expert Builder, Memory Updater).
- Each run ends with what it installed for this project and for every project.
- A home run that asks for a project-only entry in `--categories` installs nothing, names the
  entry and the command to run inside the project, and exits 2.

### Upgrading from 1.1.0
- Installer 1.1.0 installed plugins at project scope on repo runs. In each repository where it did,
  remove those copies for the plugins that are there:

  ```
  claude plugin uninstall bluecube-sdlc@bluecube-coder --scope project
  claude plugin uninstall kb-knowledge-graph@bluecube-coder --scope project
  ```

  To keep a plugin you removed, pick it on your next installer run: it installs once, at user
  scope, for every project.
- If you ran `npx @bluecube-ai/coder -g` before, fix `~/.claude/settings.json` and
  `~/.claude/CLAUDE.md` as the SDK 1.1.0 changelog describes:
  https://github.com/BlueCube-AI/bluecube-coder/blob/v1.1.0/CHANGELOG.md#110---2026-10-06

### Known limitations
- Choosing "Only this project" while the current directory is the home directory writes
  project-only entries into `~/.claude`.
- Project-scope plugin copies from installer 1.1.0 stay until removed by hand.
- The installer does not detect broken earlier `-g` installs.
- `--categories skills` is rejected as an unknown id. The SDK accepts it, but the catalog has no
  `skills` entry.
- No warning for `-g` with an `--ref` older than SDK 1.1.0. Such a run can still write
  project-only hooks at home.
- No notice of the permissions a home run writes to `~/.claude/settings.json`.
