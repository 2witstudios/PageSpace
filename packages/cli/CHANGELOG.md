# Changelog — @pagespace/cli

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.8.0] — 2026-08-23

### Added

- **`pagespace sheets` — seven verbs that treat a spreadsheet as data.** `describe` shows a sheet's
  tabs, row and column counts without reading a row. `query` filters and sorts **server-side**, so
  asking a 100,000-row sheet for the twelve rows you want no longer means pulling the whole thing
  down first. `rows` walks a tab in order, `append` adds rows, `update-cells` writes by A1 address
  (and, unlike the older `edit-cells`, can reach a tab other than the first), and `delete-rows`
  removes a range.

  Filters match **the values you see**: a formula column compares as its result, not its `=` text.

  `delete-rows` is the one irreversible verb, so it confirms before acting. `--yes` skips the
  prompt; with no TTY and no `--yes` it fails closed rather than assuming consent — a script that
  never meant to delete cannot delete by omission.

  All seven honour `--json` for scripting, and the same six operations are served as MCP tools, so
  an agent gets them without shelling out.

- **`pagespace keys describe`** — reports the credential this invocation would use: its drives, the
  role granted in each, and the **effective** permissions that role resolves to
  (view/edit/share/delete). Resolved server-side by the same code that authorizes real requests, so
  it cannot disagree with them. Drive-level permissions answer the drive-as-root-node question
  (creating a top-level page, sharing or deleting the drive), where any membership grants edit; a
  page inside can be strictly narrower, so `--page <pageId>` resolves that page too — a plain
  `member` key may create at the drive root and still be view-only on a document, which is the
  "reads fine, every write fails" shape #2470 was about. It is the one `keys` verb a key can run,
  and it describes only itself — never the other keys you hold. The same summary now closes `keys create` and the
  `pagespace keys` wizard's Create flow, and it is served as an MCP tool (`tokens.describeSelf`).
- **`pagespace keys list` shows the role granted on each drive**, including custom roles by name and
  inherit scopes spelled out, instead of the drive name alone.

### Fixed

- **`pagespace keys list`/`revoke`/`use` and the wizard no longer report a live key as invalidated.**
  Run under an `mcp_` key, they answered "Static token was invalidated and has no refresh path" —
  indistinguishable from a revoked key, while that key kept working on every content command. The
  key-management API only ever accepted a personal login; a key hitting it gets a refusal it can do
  nothing about. These commands now detect the credential class up front and say so: the key is
  fine, key management needs `pagespace login`, and `keys describe` is what a key can ask about
  itself. No round trip, no re-mint. (#2464)
- **`pagespace roles get <driveId> member` now explains itself.** It answered "not found in this
  drive", which reads as "no such role" — but `member`/`admin`/`owner` are system roles held per
  member on the drive membership, not rows in a drive's role list, so that lookup can only ever
  miss. The error now names where they live and points at `keys describe`. (#2470)

## [1.7.1] — 2026-08-10

### Fixed

- **The MCP config printed after `pagespace keys` / `pagespace keys create` no longer assumes a
  global install.** It emitted only `{"command": "pagespace", "args": ["mcp"]}`, which needs
  `pagespace` on the PATH of whatever launches the MCP client — not the case if you minted the key
  through `npx -y -p @pagespace/cli pagespace keys`, and frequently not the case for GUI clients
  (Claude Desktop, Cursor) that launch without your shell's PATH. It now prints the zero-install
  `npx -y -p @pagespace/cli pagespace-mcp` form, matching the README, and offers the global-install
  shorthand on a following line.

## [1.6.1] — 2026-07-08

### Fixed

- **`pagespace keys create --name X` now actually names the key `X`.** Every key minted via the
  browser-consent flow was previously hardcoded server-side to `"pagespace CLI"` regardless of
  the name given, making every CLI-minted key indistinguishable in `keys list` and the wizard's
  "Set active key" picker. The CLI now sends the chosen name as part of the OAuth authorization
  request; older CLI versions still mint successfully (server-side compatibility fallback), just
  without a distinguishing name — upgrade to get real names on new keys.
- **The wizard's "Set active key" flow no longer fails on a key you just created.** It used to
  reverse-match your selection against every locally stored credential via the OS keychain's
  list-all API, which on real keychains truncates every stored name at an internal separator
  byte — making it unable to tell any two named keys apart, so a freshly minted key's own
  credential was often invisible to it. It now checks for the exact name first, which is both
  faster and immune to that keychain quirk.

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
