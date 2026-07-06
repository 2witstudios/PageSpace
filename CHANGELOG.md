# Changelog

All notable user-facing changes to PageSpace are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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

### Changed

- The MCP integration docs and the Settings > MCP page now lead with `pagespace login` for
  personal use, keeping token creation for agents, CI, and drive-scoped access.

### Deprecated

- The standalone `pagespace-mcp` npm package is deprecated in favor of `pagespace mcp` (part of
  `@pagespace/cli`). It keeps working exactly as before — same tools, same env vars — and now
  prints a one-line migration notice to stderr. See the
  [migration guide](packages/cli/docs/migrating-from-pagespace-mcp.md).

### Fixed

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
