# Changelog — @pagespace/cli

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.5.0] — 2026-07-07

### Added

- **The active key: `pagespace keys use <name>`.** Activate one of your stored keys as this
  machine's ambient default — gated by the same browser consent screen that mints keys (a new
  `activate_key` OAuth ceremony that grants nothing and changes nothing server-side). Once
  active, content commands run without `--key`/env: `pagespace drives list` just works, for you
  and for coding agents driving the CLI in bash. Explicit credentials always override it;
  `keys use --off` deactivates; `whoami` shows it. `pagespace mcp` deliberately ignores the
  active key so MCP configs stay explicit and portable. Also available as a wizard menu item.
- **`keys create --show-token`** *(landed pre-release, documented now)* — prints the minted
  `mcp_` token exactly once as the only stdout line, for `.env`/CI/other-machine use.

### Changed

- **One concept, one name: keys.** The stored named credential *is* the mcp key, and every
  surface now says so: global flag `--profile` → `--key`, env `PAGESPACE_PROFILE` →
  `PAGESPACE_KEY` (old env still honored as a deprecated alias with a stderr notice),
  `keys create --save-as-profile` → `--name`. The old flags error with a pointer to the new
  name. Stored credentials are untouched — every key and login minted by 0.1.x keeps working.
- Content-command credential precedence is now: `--token`/`--key` flags →
  `PAGESPACE_TOKEN`/`PAGESPACE_KEY` env → the active key → loud refusal (never your login
  credential, which has no content access).

### Fixed

- **`pagespace mcp` no longer introduces itself as version 0.1.0.** The MCP initialize
  handshake now reports the real CLI release version (drift-guarded by tests, like every other
  version constant in 1.5.0).
- `CLI_VERSION` is drift-guarded against package.json — bumping either alone fails the suite
  (the published 0.1.x artifacts self-reported stale versions).

## [0.1.2] — 2026-07-04

Keys wizard, key-management-only login scope, `pagespace-mcp` compatibility bin.

## [0.1.1] / [0.1.0] — 2026-07-04

Initial publishes.
