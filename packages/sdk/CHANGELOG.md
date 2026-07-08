# Changelog — @pagespace/sdk

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.5.0] — 2026-07-07

### Removed

- **`tokens.create` / `createMcpToken`** — removed from the facade, the registry, and the root
  exports. The server locked key minting (POST `/api/auth/mcp-tokens`) to session auth as a
  deliberate credential-minting-escalation fix, and neither credential class the SDK documents
  (`mcp_` API keys, `ps_at_` OAuth access tokens) is accepted there — every such call returned
  401. Session credentials are reserved for first-party surfaces (browser cookie sessions and
  the desktop/mobile apps' Bearer session tokens) and are not an SDK-supported credential, so
  the operation had no supported caller. Key minting happens via the OAuth authorize/consent
  flow (`pagespace keys create`) or the web UI. `tokens.list` and `tokens.revoke` remain, and
  require a `ps_at_` OAuth access token (from `pagespace login` / the OAuth flow) — not an
  `mcp_` token.

### Fixed

- **`SDK_VERSION` now matches the published package version, with a drift guard.** The 0.1.1
  tarball shipped `SDK_VERSION = '0.1.0'` because the constant is hand-maintained; a test now
  asserts `SDK_VERSION` strictly equals package.json's `version` (read from disk, not a copy),
  so bumping either side alone fails the suite.
- **Facade wirings can no longer be silently swapped.** The facade-completeness guard only
  counted wired operation names, so transposing two wirings (e.g. `calendar.get` ↔
  `calendar.delete` — a data-destroying GET→DELETE with identical input schemas) passed the
  whole suite. Every `client.<ns>.<method>` must now resolve to the registry operation of the
  same name, with an explicit exception table for the two deliberate short names
  (`channels.send`, `channels.delete`).
- **Older servers no longer fail drive mutations at parse time.** `driveRowSchema` had gained
  two required fields (`notFoundPageId`, `publishFaviconUrl`) with no API contract version
  bump, so a server predating them passed the version handshake and then threw
  `ResponseValidationError` on a successful rename/updateContext/setHomePage. Both fields are
  now optional-nullable (tolerant read).
- **Shipped sourcemaps are now self-sufficient.** The tarball ships `dist/` only, but the maps
  referenced `../src/*.ts` with no `sourcesContent` — pure dead weight. Sources are now inlined
  (`inlineSources`), so stack traces and go-to-definition resolve for npm consumers.

### Security

- **Path parameters reject dot-segments.** `encodeURIComponent` leaves `.` intact and the URL
  parser inside `fetch` collapses dot-segments, so a path-param value of `..` (e.g. from
  untrusted input forwarded as an id) silently rerouted the request to a different same-origin
  endpoint (`/api/pages/..` → `/api/`). Values of `""`, `"."`, and `".."` now throw a
  `TypeError` naming the operation and parameter before any request is built.

### Added

- npm package metadata: `keywords`, `homepage`, `bugs`.
- README: corrected the five namespaces falsely documented as unwired (calendar, collaborators,
  commands, members, workflows — all first-class facade namespaces), documented
  `StaticTokenProvider`'s one-shot (not sticky) rejection semantics, added `HttpError` to the
  documented error taxonomy, and documented the `tokens` namespace's OAuth credential
  requirement.

## [0.1.1] — 2026-07-04

Build-on-publish via prepack. Known issue, fixed in 1.5.0: the published artifact self-reports
`SDK_VERSION` as `0.1.0`.

## [0.1.0] — 2026-07-04

Initial publish.
