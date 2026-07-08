# Changelog — @pagespace/cli

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.6.0] — 2026-07-08

### Added

- **`pagespace keys create --all-drives`** — mints an unrestricted key with access to every drive
  you own, including ones created later, equivalent to the web Settings > MCP "Clear selection
  (allow all drives)" control. Requires `--name` (there's no single drive id to default a name
  from), rejects being combined with `--drive`, and is gated behind `--yes` (or an interactive
  TTY confirm) since it mints the maximum-privilege key type. Backed by a new `all_drives` OAuth
  scope — deliberately not the `account` scope, which would silently mint a full personal login
  session instead of a revocable, listable mcp key.
- The interactive wizard's Create flow now asks up front whether to grant specific drives or all
  drives (unrestricted), instead of only offering a per-drive picker. Edit gains a confirm guard
  when narrowing an existing all-drives key down to specific drives; converting an existing key
  *to* all-drives is out of scope for Edit — mint a new key with `keys create --all-drives`
  instead.
- `keys list`/the wizard's key table now distinguish an all-drives key from an orphaned key (one
  whose scoped drives were all deleted) — both used to render identically as `(unscoped)`.

## [1.5.1] — 2026-07-08

### Changed

- **Requires `@pagespace/sdk` `^2.0.0`** (was `^1.5.0`). The SDK's `deriveCodeChallenge` — used
  internally by `pagespace login`'s loopback flow — became `async` in the SDK's `2.0.0` release
  (browser-compat fix; see `@pagespace/sdk`'s changelog), so `loopback-flow.ts` now `await`s it.
  No user-facing behavior change.

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
