# Changelog — @pagespace/sdk

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **`pages.replaceLines`/`insertLines`/`deleteLines` accept `expectedTotalLines`** — the optional
  staleness guard: the document length the caller believes it is editing. A mismatch is refused
  (409) instead of applying the edit to lines the caller has not seen. Their results now also model
  `previousTotalLines` and `contentModeWarning`, and `pages.read` models `contentModeWarning` — a
  bare `z.object` had been stripping them, so the warning never reached the caller.

## [2.2.0] — 2026-08-23

### Added

- **`client.sheets` — a spreadsheet is queryable data, not a document you download.** Six operations
  over `POST /api/mcp/sheets`: `queryRows` (filter with nested `and`/`or`/`not`, project with
  `select`, sort with `orderBy`, page with `limit`/`offset`), `getRows` (positional paging by row
  index), `describe` (tabs, row and column counts, frozen rows — without reading a row),
  `appendRows`, `updateCells` (A1 addresses, and unlike the older `documents.editSheetCells` it can
  reach a tab other than the first) and `deleteRows`. Asking a 100,000-row sheet for twelve matching
  rows now transfers twelve rows.

  Filters compare against the **computed** value, so a formula column matches on its result rather
  than its `=` text. Every cell carries both: `raw` is what was authored, `value` what it evaluates
  to. `SheetWhereInput` is exported for building filters in typed code.

  `queryRows` returns `total` — the full match count, not the page size — so a caller can report
  "20 of 4,312" without a second request. `getRows` returns `nextFromRow`, a **position**, not a
  count: advancing by `rows.length` loops forever on a sparse tab, following `nextFromRow`
  terminates.

  `describe` deliberately takes no `tabIndex`. The route resolves the tab before dispatch, so
  passing one 409s before `describe` runs — precisely for the caller who does not yet know which
  tabs exist. `deleteRows` requires both `fromRow` and `count`; neither is defaulted, because a
  wrong guess destroys data.

- **`documents.editSheetCells` now reports `recomputed`** in its `stats` — how many dependent cells
  were recalculated. The server had always returned it; the output schema didn't declare it, so zod
  stripped it before any consumer saw it.

- **`tokens.describeSelf`** (`GET /api/auth/key`) — describes the credential making the call: its
  drive scopes, the role granted in each, and the effective `{canView, canEdit, canShare,
  canDelete}` that role resolves to server-side. Unlike `tokens.list`/`tokens.revoke`, it accepts an
  `mcp_` token, because a credential describing ITSELF is not the same authority as one enumerating
  every key its owner holds. Pass `pageId` to also resolve a specific page, which can be strictly
  narrower than its drive (a `MEMBER` grant edits at the drive root and can be view-only on a
  document inside it); `page.permissions: null` means the page is out of reach entirely, which is
  deliberately not the same as all-false. It carries no identity fields — a key still cannot learn
  who owns it.
- **`tokens.list` now surfaces each drive scope's `role`, `customRoleId` and `customRoleName`.** The
  server had always returned them; the output schema didn't declare them, so zod stripped the answer
  to "what was this key granted" before any consumer saw it. They default to `null` against a server
  that omits them.

### Removed

- **`'MACHINE'` is no longer an accepted page type.** `pageTypeSchema` — and therefore
  `pages.create`, `pages.list`, search filters and the `type` on every page response — no longer
  accepts or emits it. 2.1.0 renamed `'TERMINAL'` to `'MACHINE'`; this removes the type outright,
  because the feature it named was deleted server-side. A call passing `'MACHINE'` now fails
  client-side in schema validation rather than server-side as an unknown type. **This is a narrowing
  of accepted input in a minor release**, which strict semver would call breaking; it is shipped as
  a minor because the endpoint rejects the value either way and there is no migration to perform.

### Changed

- **Calendar timezone resolution is documented as it actually behaves.** Omitting `timezone` is not
  the same as sending `"UTC"`: the server resolves an absent field against the caller's profile
  timezone and only then falls back to UTC, matching `tasks.create`/`tasks.setTrigger`.
  `calendar.create` stores the resolved zone on the event, so a later `update` that omits `timezone`
  reinterprets against the event's own zone rather than the editor's. `startDate`/`endDate` on
  `calendar.list` are absolute instants and are never reinterpreted. No SDK code changed; the
  previous documentation described behaviour that did not match the server.

### Fixed

- **A 401 that refuses a credential CLASS no longer surfaces as a dead token.** `AuthProvider` gained
  an optional `canRefresh`, and `PageSpaceClient` now spends its single auth retry only on a provider
  that can actually produce a different credential. `StaticTokenProvider` declares `canRefresh:
  false`: retrying re-sent the identical bearer, and the second pass failed inside the provider, so
  the provider's "no refresh path" error replaced whatever the server had said — turning
  "MCP tokens are not permitted for this endpoint" into "Static token was invalidated". The server's
  own refusal now reaches the caller intact, and `StaticTokenProvider`'s own message no longer claims
  to know that the token is invalid. **Custom `AuthProvider` implementations need no change** —
  an omitted `canRefresh` keeps the previous retry behaviour.

## [2.1.0] — 2026-07-10

### Changed

- **The `'TERMINAL'` page type was renamed to `'MACHINE'`.** `pageTypeSchema` (and therefore
  `createPage`) now accepts `type: 'MACHINE'` in place of `type: 'TERMINAL'` — the same page (a
  Sprite-backed "Machine"); `'TERMINAL'` was only ever the internal name for the UI surface that
  lives *inside* a Machine. This is **not** treated as a breaking major bump: creating this page
  type is admin-only and experimental-gated (it never shipped GA), so no stable consumer passes it.
  The net public change is additive — `'MACHINE'` is now an accepted value.
  **If you were passing `type: 'TERMINAL'`** (experimental use only), pass `type: 'MACHINE'` instead.

## [2.0.0] — 2026-07-08

### Breaking Changes

- **`deriveCodeChallenge` is now `async`, returning `Promise<string>` instead of `string`.**
  Required to make the PKCE helpers work in a browser bundle (see below) — there is no synchronous
  SHA-256 primitive available in a browser, so this could not ship as a patch/minor release without
  silently breaking any caller that used the return value synchronously. Confirmed via automated
  review before merge: the already-published `@pagespace/cli@1.5.0` depends on
  `@pagespace/sdk: ^1.5.0` and its published build calls this synchronously (unawaited) — publishing
  this fix as a `1.x` patch would have meant every *existing* CLI install silently picked up the
  new async SDK on its next `npm install` and started sending `[object Promise]` as the OAuth
  `code_challenge`, breaking `pagespace login` with no code change on the CLI's side at all. Shipping
  as `2.0.0` means npm's `^1.5.0` range on the already-published CLI does not resolve to it — only a
  consumer that explicitly opts into `^2.0.0` (this repo's own `packages/cli`, bumped in the same
  change) is affected.
  **Migration:** `await deriveCodeChallenge(verifier)` instead of `deriveCodeChallenge(verifier)`.
  `generateCodeVerifier` is unaffected (still synchronous).

### Fixed

- **Every API call from a real browser threw `TypeError: Failed to execute 'fetch' on 'Window':
  Illegal invocation`, before the request ever reached the network.** `client.ts` captured a
  detached reference to the global `fetch` (`options.fetch ?? fetch`) and later invoked it in
  method-call position through an options object (`options.fetch(url, ...)`). Browsers require
  `fetch`'s receiver to be the real `Window` object; Node's `fetch` (undici) has no such check, so
  this was invisible to the entirely-Node vitest suite and only surfaced building a real
  browser-based demo app. Fixed by binding to `globalThis` at construction time
  (`fetch.bind(globalThis)`), which satisfies the receiver check in both environments. The
  existing `options.fetch` injection point (used throughout the test suite's `vi.fn()` mocks) is
  unaffected — this only changes the default when no `fetch` override is supplied.
- **`generateCodeVerifier`/`deriveCodeChallenge` (PKCE math, public SDK surface) used
  `node:crypto` and `Buffer` directly and could not run in a browser bundle at all.** Needed by any
  browser app implementing its own `pagespace login`-equivalent OAuth flow (not needed for simple
  `StaticTokenProvider` API usage). Rewrote `packages/sdk/src/auth/pkce.ts` on the Web Crypto API
  (`crypto.subtle.digest`, `btoa`), which both Node 20+ and every real browser provide. Output is
  byte-for-byte identical to the old `Buffer`-based encoding for the same inputs, verified by the
  existing drift-guard test against `@pagespace/lib`'s canonical (Node-only, server-side) copy. Its
  one in-repo caller, `packages/cli/src/auth/loopback-flow.ts`, now `await`s it — see the breaking
  change entry above for why this could not ship as a patch/minor version.

## [1.5.1] — 2026-07-08

### Fixed

- **`pages.read` (`read_page`) was broken for every plain page — DOCUMENT, FOLDER, CANVAS, CODE,
  and completed FILE pages — the single most common case.** `genericReadResultSchema` declared
  `pageType: z.undefined()` to assert that branch's responses never carry a `pageType` field. But
  JSON cannot encode "key present with value `undefined`" (`JSON.stringify` always drops such
  keys), so every real server response for this branch has `pageType` genuinely *absent*, not
  present-as-undefined — and a bare (non-optional) `z.undefined()` field requires the key to
  actually exist. Confirmed live against production and via a comprehensive full-endpoint sweep:
  every `pages.read` call on a non-TASK_LIST/CHANNEL/FILE page failed with
  `RESPONSE_VALIDATION_ERROR`, including through `pagespace mcp`'s `read_page` tool (same SDK
  invoke pipeline underneath). Fixed via `pageType: z.undefined().optional()`, which still
  correctly rejects a real `pageType` string (so TASK_LIST/CHANNEL/FILE responses can't silently
  parse against this branch instead of their own) while accepting the real-world missing-key case.
  Not a regression from 1.5.0 — `documents.ts` was untouched by that release; this bug predates it
  (present since at least 0.1.1) and was only now caught by exhaustive live-production testing.
- **Root cause note (informational, not fixed here):** the specific failure was version-dependent
  on *zod itself* — `z.undefined()`'s treatment of a missing key changed between zod 4.3.6 (accepts
  it) and 4.4.3 (rejects it, requiring the key to exist). This repo's own test suite runs against
  whatever zod its lockfile has pinned (4.3.6 at the time of the 1.5.0 release) and never caught
  this, while a fresh `npm install` today resolves 4.4.3+ under the SDK's `"zod": "^4.1.8"` range.
  The `.optional()` fix is verified stable across both zod versions, but the underlying dependency-
  range fragility (CI can pass while every real consumer's resolved zod silently behaves
  differently) is a broader hardening item worth a follow-up, not addressed in this patch.

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
