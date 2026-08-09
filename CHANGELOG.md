# Changelog

All notable user-facing changes to PageSpace are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- **A pane appears in the sidebar the moment it exists** — the sidebar and the pane layout used to
  be two separate records of what a session contained, kept in step by convention, so a pane you or
  an agent opened could take up to two minutes to show up in the list. They are now two views of
  one thing, so there is nothing to fall out of step.
- **A thread can no longer go missing from its own session** — a session's membership and its
  layout were stored separately, and a thread that had no pane was simply absent from the list.
  Sessions existed with more threads than the sidebar would show. Membership is now the same record
  as placement, so a thread that is in a session is always visible in it, open or not.
- **Opening a conversation that is already open in another session says so, instead of leaving a
  dead pane behind** — a conversation lives in exactly one pane, and trying to show one that
  another session already holds used to fail as a server error. The pane you had just opened stayed
  on screen, showing nothing, until something else happened to refresh the layout. The attempt is
  now refused properly and the layout corrects itself straight away.
- **Panes and sidebars no longer sit blank while the messages are right there in the database** —
  every surface used to keep its own private copy of a conversation and its own theory of when to
  refresh, so a message written from one surface could stay invisible in another until you
  reloaded. Every surface is now a subscriber to one authoritative feed and can tell when it has
  missed something, so it refetches instead of quietly showing you stale history.
- **Workers you spawn appear immediately instead of up to 20 seconds later** — the sidebar polled
  on a timer; it is now told.
- **One chat history** — page chats and Global Assistant chats were stored in two different tables
  with two different code paths, which is why a handful of features worked in one and not the
  other. They are one now.
- **A plan on a shared conversation is visible to the people it is shared with** — the plan chip
  silently failed to load for anyone but the conversation's owner, so collaborators saw no plan on
  a conversation whose agent was visibly working from one.
- **Closing one pane no longer stops another from receiving live updates** — two views of the same
  conversation (say the Global Assistant on your dashboard and a pane in the Agents console) shared
  one subscription, so closing either one silently cut the other off until you reloaded.
- **Layout changes no longer go missing on self-hosted deployments reached over plain HTTP** — in
  that setup a reload could reuse ids from the previous page load, and a split or resize would be
  mistaken for one already applied and quietly dropped.
- **The Agents console's tab now shows "Agents" and remembers what was open when you switch away and back** —
  the browser-style tab bar didn't recognize `/dashboard/agents` as a page at all, so its tab showed
  "Drive" or "Untitled" instead of "Agents". Worse, the console keeps its selected session/conversation/panes
  in the URL's query string (so clicking around never kills a live shell or streaming chat), but the tab bar
  never carried that query string along — so switching to another tab and back always dropped the selection,
  landing on "Select a session" even though the panes were still safely persisted underneath. Tabs now carry
  their full address, the Agents route is registered with a proper title and icon, reactivating a different
  tab pointing at the same Agents page now correctly re-reads its own selection, and the header's Back/Forward
  buttons no longer get one step out of sync after the browser's own Back restores an earlier selection.
- **Global Assistant is no longer unclickable right after splitting a pane in the Agents console** —
  a short pane's empty-pane picker could crush its "Shell"/"Global Assistant" choices under the
  "Agents" list below them, so the Global Assistant button visually collided with — and lost clicks
  to — the section beneath it. The picker's sections no longer shrink below their own content.
- **The Agents console's session list no longer shows a distracting scrollbar** — the sidebar's
  left-hand session list now scrolls without ever painting a scrollbar, matching the rest of the
  console's chrome-free feel.
- **A Global Assistant conversation started from the global Agents dashboard now keeps the right
  drive's context** — picking Global Assistant for a specific drive from `/dashboard/agents` (rather
  than that drive's own Agents page) minted a session correctly scoped to that drive, but the
  assistant itself had no way to know which drive it was in — it derived that from the current page,
  and the Agents console never navigates as you click between sessions. It now reads the drive
  straight from its own session instead.
- **A database outage no longer takes the whole platform down with it** — when Postgres
  became unreachable (as in the recent OOM stalls), the rate limiter denied every request
  platform-wide, turning a database incident into a total outage. Production now degrades to
  a conservative per-instance in-memory limit at half the configured threshold: legitimate
  users keep working, attackers face a *stricter* limit than usual, and nothing ever fails
  open. A 30-second circuit breaker stops requests from waiting on the stalled database
  (a single probe rechecks it each cooldown), the fallback's memory is hard-capped so an
  identifier flood can't exhaust the process, and distributed enforcement resumes
  automatically the moment Postgres recovers.

- **A machine-bound agent addressing its own project's default checkout as `branch: "main"`/`"master"` is no longer silently denied** —
  a bound conversation's `target` only ever resolved against explicitly created branch worktrees, so a model reasoning in ordinary
  git terms (where "main" means "my own checkout") got refused with a generic scope error even when addressing itself. The system
  prompt now explains that "branch" here names a separately created worktree, not "whatever branch a project happens to be on," and
  the denial message points at `list_sessions` to check real state instead of prescribing a specific retry.
- **Permanently deleting a Terminal machine, its drive, or letting it age out of Trash no longer
  leaves "Unknown machine" behind** — an agent or the global assistant's machine list kept a
  reference to a Terminal after the machine page was gone for good, so it showed as "Unknown
  machine" and any subsequent save of that config failed. Permanent delete, permanent drive
  delete, and the daily trash-purge now clean up the stale reference; a machine that's merely in
  Trash (not yet purged) is left alone since it can still be restored.
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

### Changed

- **Closing the last pane no longer ends your session** — it leaves the session open with an empty
  layout. Ending a session is its own act, aimed at the session rather than inferred from the last
  pane going away, so closing something can never end more than you asked it to.

### Added

- **Your agent workspaces now follow you between devices, and agents can arrange their own** —
  the pane grid in the Agents console used to live partly in your browser's local storage, so the
  same workspace looked different on your laptop and your phone, and a collaborator watching a
  shared workspace saw nothing you did. The layout is now server-held: open, close, move, resize
  and rearrange panes converge live for everyone looking at that workspace, on every device.
  Agents can arrange their own workspaces too, through the same verbs you use — an agent can open
  the page it is about to edit next to the conversation you are having about it.
- **`list_sessions` can now see workspaces shared with you** — an agent could always be *told* to
  work in a colleague's workspace in a drive you both belong to, but had no way to discover one.
  It now lists them, with other members' private thread titles shown as "(private thread)" so the
  workspace is discoverable without its contents being readable.
- **`/plan` ships as an editable starter skill** — an agent can bind a conversation to a plan
  document and keep working against it across reloads and context summaries, with the plan shown
  as a chip on the conversation.

- **Agent sessions and the sandbox are open to everyone — the sandbox itself is a Pro+ feature** —
  sessions, chat, and the Agents screen's panes (splitting between agent conversations, a terminal,
  and any page) are now available to every authenticated user, not just admins. Real cloud compute —
  an agent session's sandbox, where it actually runs code and gives you a terminal — requires Pro
  tier or above, billed to the session's payer (the drive owner, or the session's own owner for a
  driveless Global Assistant session), so a free-tier member with edit access in a Pro-owned drive still gets sandbox
  access. Sessions whose resolved payer is on the free tier get the same session/panes UI, with the
  terminal affordance disabled and an upgrade prompt where the sandbox would run. Scheduled/triggered Workflows now honor the same
  per-agent sandbox switch and payer-tier gate as interactive chat, closing a gap where a workflow
  could reach code-execution tools regardless of an agent's own sandbox setting.
- **Start a session with Global Assistant directly from a drive** — clicking "+" on a drive in the
  Agents console now offers Global Assistant alongside that drive's own agents and Shell, first in
  the list. The new session is filed under that drive, same as any agent session, rather than only
  being reachable as a driveless global session. Its default name now also reads "Global Assistant"
  (was "Assistant") everywhere a session or conversation goes unnamed.
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

- **Agent settings are now a compact menu instead of one long scrolling form** — opening an
  agent's settings (from the full agent page or from a pane) now shows a short list of categories
  — Behavior, Access, Tools, and Integrations — instead of every option stacked on one
  continuously scrolling page, and no longer shows an empty scrollable region when an agent has no
  tools available. The full page and pane surfaces now share the same navigation, and
  Integrations — previously only reachable from the full page — is available from panes too.
  Unsaved edits are preserved when moving between the category menu and a configuration subpage,
  and each pane tracks its own navigation state independently.
- **Every Terminal agent session now runs in its own isolated sandbox** — previously only a
  *branch* session got a separate Sprite, while machine- and project-scoped sessions shared the
  owning Machine's single Sprite, so two agents spawned at the same location collapsed onto one
  filesystem. Now each spawned session (machine, project, or branch scope) provisions and runs in
  its **own** Sprite: two agents at the same location are two independent, isolated machines that
  can never see or clobber each other's files, and each one's Claude Code login is copied in from
  the Machine's own Sprite (where you run `claude login`). **Billing implication:** a Machine can
  now hold several concurrent Sprites instead of one, so active runtime cost scales with how many
  sessions you actually run at once; each session's persistent disk is metered per session and
  billed to the owning Machine (a paused/hibernating session bills only for the bytes it has
  stored, not RAM). Closing a session, deleting its project, or deleting the Machine tears down and
  reclaims that session's Sprite, so nothing keeps billing once you're done with it. Sessions
  spawned under a Machine that has already been moved to Trash are refused rather than silently
  creating a hidden, unreclaimable sandbox.
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
