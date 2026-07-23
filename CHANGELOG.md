# Changelog

All notable user-facing changes to PageSpace are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- **Toast notifications now actually appear** — member management, role editing, drive AI
  settings, drive deletion, invites, and version-history/activity rollback actions had been
  silently logging success and error feedback to the browser console instead of showing a
  toast, since December 2025. These flows now surface real toast notifications.
- **Subscription renewals now set the correct billing period** — a renewal used to stamp your
  account with the billing cycle that had just *ended* (Stripe reports the old cycle on the invoice
  itself; the new one is on its line items), so every subscriber's period looked expired the moment
  they renewed. Renewals and plan changes now record the service period actually paid for.
- **Usage page no longer freezes on a stale billing period** — if your monthly period lapsed
  without a renewal landing (comped accounts, or a delayed invoice), the usage breakdown silently
  clamped to the old window and showed nothing you'd spent since. It now falls back to the trailing
  30 days so current usage — including Terminal machine time — always shows.
- **Comped paid accounts get their monthly credit allowance again** — accounts on a paid tier with
  no live Stripe subscription (founder/comped) never received an `invoice.paid` refill, so their
  allowance and billing window froze permanently. The credit gate now rolls their window and grants
  the tier allowance, the same way free-tier accounts refill. Subscription-backed accounts are
  unchanged (Stripe stays authoritative).
- **Terminal sessions now bill in 10-minute heartbeats** — interactive machine sessions previously
  settled their runtime cost only when the session ended, so a server restart mid-session (every
  deploy) silently dropped the whole session's usage. Heartbeat settling bounds any loss to at most
  one interval, and a payer who runs out of credits mid-session is disconnected instead of running
  free.

### Added

- **Rotate a webhook secret in place** — the Incoming Webhooks dialog (and
  `POST /api/pages/[pageId]/webhooks/[id]/rotate`) now mints a fresh signing secret for the **same
  webhook URL**, so replacing a lost or leaked secret no longer means deleting the webhook and
  re-wiring the external sender to a new URL. The old secret stops verifying the moment the
  rotation lands; the new one is shown exactly once, just like at creation. Owner/admin only,
  audited, and concurrent rotations are serialized — the losing request gets a conflict instead of
  silently minting a secret nobody can use.
- **Incoming Webhooks** — mint a signed, page-scoped URL (owner/admin only, from the webhook icon
  on a Channel or AI Chat page) so an external system — CI, monitoring, a script — can push events
  into PageSpace without a full drive-scoped credential. A signed delivery to a Channel webhook
  posts its `content` verbatim as a message; binding one or more workflows to a webhook (via the
  new `/api/pages/[pageId]/webhooks/[id]/triggers` API) makes the same delivery also fire those
  workflows with the full payload as context — the two actions compose rather than being mutually
  exclusive. See [the Incoming Webhooks docs](https://pagespace.ai/docs/integrations/incoming-webhooks)
  for the HMAC signing scheme and a working curl example. This is distinct from the existing
  outbound "Generic Webhook" AI tool provider, which lets an agent call out to an arbitrary URL —
  Incoming Webhooks is the opposite direction.
- **`pagespace drives update-context` and a full `pagespace roles` command family** — the CLI can
  now set a drive's AI context prompt (`drives update-context <driveId> <drivePrompt>`) and
  manage custom drive roles end-to-end (`roles list|get|create|update|delete`,
  `set-page-permissions`, `set-drive-wide-permissions`, `remove-page-permissions`) — previously
  these were only reachable via the full MCP tool registry, not the `pagespace` CLI directly.
- **Approve a device's active key in the browser** — the `pagespace` CLI's new
  `pagespace keys use <name>` sets one of your access keys as a machine's ambient default, gated
  by the same browser consent screen that mints keys. The consent page now narrates this
  activation ceremony explicitly ("make *key* the active key on the device that sent you here");
  nothing about the key or its access changes, and no secret is issued.
- **Custom 404 pages for published Canvas sites** — pick any Canvas page in a drive's Domains &
  Publishing settings to serve as the site's 404 page, instead of the generic branded fallback.
- **Drive-wide favicon setting** — set a favicon for a published site (previously only settable by
  hand-authoring a `<link rel="icon">` tag inside a canvas page).
- **Pick an uploaded image for OG share image / favicon** — the Domains & Publishing settings and
  the per-page publish dialog now offer a "browse uploaded files" picker as an alternative to
  pasting a URL. Picking a file resolves it to a durable public link, fixing links to your own
  uploaded files that previously required sign-in and silently failed to load for site visitors.
- **Pick a GitHub repo when adding a Terminal project** — the Terminal Navigator's "Add project"
  dialog now defaults to a searchable picker over your connected GitHub repos instead of requiring
  a pasted clone URL, with a "Connect GitHub" prompt if you haven't connected yet and a manual URL
  entry still available as a fallback.

- **21 new sandbox git/GitHub tools** — agents with code execution can now edit PR titles and
  descriptions (`gh_pr_edit`), leave top-level PR and issue comments, edit/close/reopen issues,
  discover repositories (`gh_repo_view`/`gh_repo_list`), search GitHub code/issues/PRs/repos
  (`gh_search`), list repo labels, inspect commits (`git_show`, `git_blame`), revert a commit,
  recover from conflicted merges/rebases (`action: abort/continue`), re-run failed CI
  (`gh_run_rerun`), list and dispatch workflows, list and resolve PR review threads, and fork or
  create repositories.
- **12 new GitHub integration tools** — agents without code execution get a full write path to
  code: create branches, commit and delete files, open/update/merge pull requests, plus CI
  visibility (check runs, workflow runs), commit listing, branch comparison, issue search, and
  label listing. A new **Contributor** tool bundle covers the branch → commit → PR → merge flow.
- The GitHub connection now requests the `workflow` scope so agents can commit changes to GitHub
  Actions workflow files. Existing connections keep working; reconnect GitHub in Settings >
  Integrations to pick up the new permission.

- **`pagespace` CLI** — install `@pagespace/cli`, run `pagespace login`, and use verbs like
  `pagespace drives list`, `pagespace pages read`, `pagespace search text`, and `pagespace tasks
  create` without hand-minting a token first.
- **CLI login** — `pagespace login` opens a browser for an OAuth login with PKCE; `pagespace login
  --device` covers machines with no browser (CI, remote boxes). Both replace copying a token out of
  Settings by hand as the primary way for a person to authenticate.
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
- **`pagespace keys`** — a guided terminal wizard to create, list, edit, and revoke your scoped
  access keys — the same keys Settings > MCP already creates — without opening the web
  Settings > MCP page. It's the fast path for minting content access now that `pagespace login` no
  longer grants any on its own. `pagespace keys create`, `pagespace keys list [--json]`, and
  `pagespace keys revoke <tokenId>` are flag-driven, scriptable equivalents of the same wizard
  actions.
- **`packages/cli/docs/agent-access.md`** — states plainly what a scoped `pagespace keys create`
  credential does and doesn't protect against: it limits what a leaked/misused credential can do,
  not who else on the same machine can use it. A process with real shell access reads whatever its
  OS user can read, credential store included — no CLI feature changes that. The actual isolation
  boundary is a dedicated OS user, container, or VM that receives only a scoped token via
  `PAGESPACE_TOKEN`.
- **Machine page Files tab** — browse, open, and edit files directly on a Machine's own root
  filesystem or any branch checkout, with a PageTree-matched file tree (lazy-loaded directories,
  sorted directories-first) and an editable pane with Monaco language detection, binary-file
  detection, and Cmd/Ctrl-S save. Right-click or the "+" palette to create files/folders, rename,
  move, copy, delete, upload (10 MiB cap), or download (50 MiB cap) — every mutation requires edit
  access and is audited. A machine that hasn't been started yet shows an explicit "not started"
  state instead of an empty tree.

### Changed

- **`pagespace login` is for you, personally; `pagespace keys create` (or the guided `pagespace
  keys`) is for an agent** — the README, `docs/agent-access.md`, and the Settings > MCP page now
  say this explicitly and point agent/MCP setups at `pagespace keys create --drive <id>
  --save-as-profile agent` (paired with `--profile agent` / `PAGESPACE_PROFILE`) instead of
  `pagespace login`, which now grants only a key-management credential with no content access of
  its own (see "key-management-only login" below).
- **`pagespace login` (and `--device`) now print the scope granted on success**, e.g. `Scope:
  manage_keys offline_access — key-management access only, with zero content access; run
  "pagespace keys create" to mint a scoped key for actual content access.`, bringing it to
  parity with `whoami`, which already reported scope.
- **`pagespace help` is grouped by resource** (Auth, Drives, Pages, Search, Tasks, Agents, Keys,
  MCP, Other) with one runnable example per group, replacing the previous flat ~46-line list.

### Deprecated

- The standalone `pagespace-mcp` npm package is deprecated in favor of `pagespace mcp` (part of
  `@pagespace/cli`). It keeps working exactly as before — same tools, same env vars — and now
  prints a one-line migration notice to stderr. See the
  [migration guide](packages/cli/docs/migrating-from-pagespace-mcp.md).

### Security

- **`drizzle-orm` bumped past a SQL-identifier-escaping vulnerability (CVE-2026-39356 /
  GHSA-gpj5-g38j-94v9, CVSS 7.5)** — versions through 0.45.1 quoted SQL identifiers produced by
  `sql.identifier()`/`.as()` without doubling embedded double-quotes, so a hostile identifier
  reaching one of those call sites could break out of the quoted identifier and inject SQL. An
  audit of every `sql.identifier()` call site in the codebase found none reachable with
  attacker-controlled input today, but `drizzle-orm` is now pinned to `^0.45.2` (and
  `drizzle-kit` to `^0.31.10`) everywhere it's declared, with a regression test guarding both the
  escaping behavior and the version floor against a future re-pin.
- **Settings > Account now lists and revokes connected apps** — every OAuth-authorized client
  currently holding a grant on your account (including the `pagespace` CLI), with its scope in
  plain language and when it was connected, is now visible from a "Connected Apps" section.
  Previously the only way to revoke a `pagespace login` credential was `pagespace logout` from the
  same machine that held it — if a laptop was lost or stolen, there was no way to shut off its
  access from the web. Revoking a grant here immediately invalidates its refresh token and
  requires a fresh step-up confirmation (passkey tap, or a confirmation email if you have no
  passkey), the same as minting one.
- **`pagespace keys create` now requires browser consent** — minting a scoped credential from
  the CLI opens the same OAuth consent screen `pagespace login` uses, scoped to the requested
  drive(s), instead of POSTing directly to the token-minting API with whatever ambient credential
  was on hand. That direct-POST path let a script or agent with shell access mint itself a new
  token unattended; it's gone. The resulting credential is stored locally under a named profile
  (`--save-as-profile`, defaulting to the drive id) rather than printed, so it isn't a source for a
  portable secret — mint one of those from **Settings → MCP** instead. As a consequence, `keys
  create` no longer supports `--json` output — there's no portable token left to emit, and the
  command now blocks on an interactive browser consent screen either way — while `keys list
  --json` and `keys revoke` are unaffected.
- **BREAKING: `pagespace mcp` no longer falls back to your personal login.** Previously, running
  `pagespace mcp` with no `--token`/`PAGESPACE_TOKEN`/`--profile` silently authenticated as
  whichever profile `pagespace login` had stored — so an MCP client config missing its intended
  scoped token would unknowingly hand an automated agent your full personal account access instead
  of failing loudly. `mcp` now refuses to start the stdio server at all unless the invocation
  names a credential itself (`--token`, `PAGESPACE_TOKEN`, `--profile`, or `PAGESPACE_PROFILE`),
  and exits with a message pointing at `pagespace keys create ... --save-as-profile <name>`. The
  legacy `PAGESPACE_AUTH_TOKEN` env var (`npx pagespace-mcp`) still counts as explicit and is
  unaffected. This no-ambient-fallback gate has since been generalized to every command — see
  below.
- **BREAKING: every `pagespace` command now requires an explicit credential, not just `mcp`.**
  The fail-closed gate above was `pagespace mcp`-only at first; it now applies CLI-wide. Any
  command that reads or writes your data — `drives list`, `pages read`, `search text`, and so on
  — now fails with an actionable error instead of silently running as your personal
  `pagespace login` if invoked with no `--token`, `PAGESPACE_TOKEN`, `--profile`, or
  `PAGESPACE_PROFILE`. `login`, `logout`, `whoami`, `help`, and the whole `keys`
  surface are exempt, since each of those either mints its own credential or only ever acts on
  your own account/keys.
- **BREAKING: `pagespace login` now grants a key-management-only credential (`manage_keys
  offline_access`) by default, not full account access.** Combined with the change above, a fresh
  `pagespace login` no longer gives you (or anything reading its stored credential) any content
  access at all — it only lets you manage your own access keys, including through the new
  `pagespace keys` wizard. Run `pagespace keys` (or `pagespace keys create --drive <id>
  --save-as-profile <name>`) afterward to mint a credential that can actually read or write
  content, and pass it with `--profile <name>` / `PAGESPACE_PROFILE`. **Nothing is revoked and no
  one is logged out by this change**: a credential from an older `pagespace login` (scoped to
  `account offline_access`) keeps working exactly as before, with its original full-account
  access, until you explicitly run `pagespace logout && pagespace login` (or simply `pagespace
  login --yes` to overwrite it) to pick up the new default.

### Fixed

- **Request middleware is now edge-safe and actually deployable** — registering the previously
  dormant middleware took production down because its import graph reached Node-only code (the
  database client and server logger) that the Edge runtime cannot execute. Middleware now uses
  pure leaf modules (token prefixes, an edge-safe structured logger) and forwards API metrics to
  the internal ingest route instead of writing to the database in-process; the build now fails
  fast if a Node-only import ever reaches the middleware bundle again. Admin monitoring
  dashboards begin receiving API request metrics once this deploys — the previous in-middleware
  metrics writer had never actually run.
- **GDPR data exports now include system logs, API metrics, and error logs** — the account data
  export (`Settings > Privacy > Download my data`) previously omitted these three monitoring
  tables even though they can carry your user ID until account deletion. They're now included in
  both the native ZIP (`system-logs.json`, `api-metrics.json`, `error-logs.json`) and the portable
  schema.org export, with raw stack traces, IP addresses, user agents, and internal admin fields
  redacted.
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
