# Changelog

All notable user-facing changes to PageSpace are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **`pagespace` CLI** — install `@pagespace/cli`, run `pagespace login`, and use verbs like
  `pagespace drives list`, `pagespace pages read`, `pagespace search text`, and `pagespace tasks
  create` without hand-minting a token first.
- **CLI login** — `pagespace login` opens a browser for an OAuth login with PKCE; `pagespace login
  --device` covers machines with no browser (CI, remote boxes). Both replace copying a token out of
  Settings by hand as the primary way for a person to authenticate.
- **`pagespace tokens create` / `list` / `revoke`** — mint and manage scoped agent/CI tokens from
  the terminal, the same tokens Settings > MCP already creates.
- **`@pagespace/sdk`** — a typed TypeScript client (`PageSpaceClient`) for the PageSpace API,
  covering drives, pages, roles, tasks, agents, conversations, exports, tokens, search, activity,
  and channels.
- **`pagespace mcp`** — a stdio MCP server generated from the same operation registry as the CLI
  and SDK, so Claude Desktop, Claude Code, Cursor, and other MCP clients get a tool surface that
  can't drift from what the CLI itself supports.
- **Channel image attachments for @mentioned agents** — when you @mention an AI agent in a
  channel or DM, recent image attachments in the conversation are now passed to vision-capable
  agents as visual context (capped at 5 images per consultation, matching the per-message chat
  limit). Agents without a vision-capable model get a text note instead, so they know an
  attachment existed but couldn't be viewed.
- **`packages/cli/docs/agent-access.md`** — states plainly what a scoped `pagespace tokens create`
  credential does and doesn't protect against: it limits what a leaked/misused credential can do,
  not who else on the same machine can use it. A process with real shell access reads whatever its
  OS user can read, credential store included — no CLI feature changes that. The actual isolation
  boundary is a dedicated OS user, container, or VM that receives only a scoped token via
  `PAGESPACE_TOKEN`.

### Changed

- **`pagespace login` is for you, personally; `pagespace tokens create` is for an agent** — the
  README, `docs/agent-access.md`, and the Settings > MCP page now say this explicitly and point
  agent/MCP setups at `pagespace tokens create --drive <id> --save-as-profile agent` (paired with
  `--profile agent` / `PAGESPACE_PROFILE`) instead of `pagespace login`, which grants full personal
  account access.
- **`pagespace login` (and `--device`) now print the scope granted on success**, e.g. `Scope:
  account offline_access — this is your full personal account access.`, bringing it to parity with
  `whoami`, which already reported scope.
- **`pagespace help` is grouped by resource** (Auth, Drives, Pages, Search, Tasks, Agents, Tokens,
  MCP, Other) with one runnable example per group, replacing the previous flat ~46-line list.

### Deprecated

- The standalone `pagespace-mcp` npm package is deprecated in favor of `pagespace mcp` (part of
  `@pagespace/cli`). It keeps working exactly as before — same tools, same env vars — and now
  prints a one-line migration notice to stderr. See the
  [migration guide](packages/cli/docs/migrating-from-pagespace-mcp.md).

### Security

- **Settings > Account now lists and revokes connected apps** — every OAuth-authorized client
  currently holding a grant on your account (including the `pagespace` CLI), with its scope in
  plain language and when it was connected, is now visible from a "Connected Apps" section.
  Previously the only way to revoke a `pagespace login` credential was `pagespace logout` from the
  same machine that held it — if a laptop was lost or stolen, there was no way to shut off its
  access from the web. Revoking a grant here immediately invalidates its refresh token and
  requires a fresh step-up confirmation (passkey tap, or a confirmation email if you have no
  passkey), the same as minting one.
- **`pagespace tokens create` now requires browser consent** — minting a scoped credential from
  the CLI opens the same OAuth consent screen `pagespace login` uses, scoped to the requested
  drive(s), instead of POSTing directly to the token-minting API with whatever ambient credential
  was on hand. That direct-POST path let a script or agent with shell access mint itself a new
  token unattended; it's gone. The resulting credential is stored locally under a named profile
  (`--save-as-profile`, defaulting to the drive id) rather than printed, so it isn't a source for a
  portable secret — mint one of those from **Settings → MCP** instead. As a consequence, `tokens
  create` no longer supports `--json` output — there's no portable token left to emit, and the
  command now blocks on an interactive browser consent screen either way — while `tokens list
  --json` and `tokens revoke` are unaffected.
- **BREAKING: `pagespace mcp` no longer falls back to your personal login.** Previously, running
  `pagespace mcp` with no `--token`/`PAGESPACE_TOKEN`/`--profile` silently authenticated as
  whichever profile `pagespace login` had stored — so an MCP client config missing its intended
  scoped token would unknowingly hand an automated agent your full personal account access instead
  of failing loudly. `mcp` now refuses to start the stdio server at all unless the invocation
  names a credential itself (`--token`, `PAGESPACE_TOKEN`, `--profile`, or `PAGESPACE_PROFILE`),
  and exits with a message pointing at `pagespace tokens create ... --save-as-profile <name>`. The
  legacy `PAGESPACE_AUTH_TOKEN` env var (`npx pagespace-mcp`) still counts as explicit and is
  unaffected. Every other command's ambient-fallback convenience is unchanged — this is specific
  to `mcp`, whose whole purpose is being invoked unattended.

### Fixed

- **`pagespace login` no longer hangs after a successful login** — the post-login identity
  lookup used to retry for up to 2 minutes before the CLI would return control to your terminal;
  it's now bounded to a few seconds so the command finishes promptly. The browser callback page
  shown at the end of the flow is also redesigned to match PageSpace's branding instead of
  showing a bare, unstyled page.
- **Drive role permission updates are now atomic** — granting or revoking a role's per-page
  permission (via the share dialog, the roles API, or an AI agent tool) could previously race a
  concurrent grant/revoke on the same role and silently drop it, because the update read the
  role's permissions, merged in JS, and wrote the whole map back with no lock in between. Updates
  now merge under a row lock inside a transaction, and setting a role as default no longer risks a
  database deadlock or two roles ending up marked default at once.
- **AI streams no longer lose mid-response content when the server process restarts** — an
  in-progress AI reply's content is now checkpointed to the database as it streams, so reopening
  the channel (or resuming on mobile) shows the restored partial answer instead of a stalled
  "streaming" indicator with nothing behind it.
- Builtin integrations (GitHub, Slack, Notion, generic webhook) now always use the current tool
  definitions after a deploy. Previously a stale cached copy of the provider config could keep
  agents on renamed tools or missing bundles until something happened to refresh it.
- Custom integration providers can no longer register a slug reserved by a builtin provider
  (the API now returns 409), and a custom provider whose slug already collides with a builtin
  keeps its own configuration instead of being silently handed the builtin's tools and OAuth
  settings.
- On mobile, the app no longer loads in the wrong theme and switches after first paint — a race
  that could leave the navbar "half stuck" in the previous theme's colors on iOS/Android WebKit.
  The saved theme is now resolved server-side before the first render, and theme toggles force the
  translucent "liquid glass" surfaces to repaint.
