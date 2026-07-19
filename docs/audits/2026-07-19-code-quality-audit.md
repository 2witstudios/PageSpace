# Code Quality Audit — 2026-07-19

Full-monorepo audit targeting: AI-slop patterns, impure functions, high-churn/high-risk areas, outright failures, security doors left open, and code that looks right but isn't fully wired up. Eight parallel deep-dive passes covered the AI chat/streaming layer, auth/permissions/security, API route + DB wiring, frontend state/hooks, background services (realtime/processor/control-plane/integrations), and test/CI hygiene. Every finding below was verified against source (call paths, consumers, and migration journal traced); the headline findings were independently re-verified.

Churn context: within the visible git window, 33% of commits are fixes, concentrated almost entirely in the AI chat/streaming layer (task-board crash-prevention epic, cross-conversation stream mis-keying fix #2121). Several findings below are the *next* instances of exactly those bug classes.

---

## Critical

### C1. Zoom OAuth refresh discards the rotated refresh token — every connection dies after one refresh cycle
`apps/web/src/lib/integrations/zoom/token-refresh.ts:46,113-122`

Zoom rotates refresh tokens on every refresh grant. The refresh response is parsed as `{ access_token, expires_in }` only; the new `refresh_token` is dropped and the DB update writes only `accessToken`/`tokenExpiresAt`. First refresh succeeds and invalidates the stored refresh token; the next refresh (~1h later) presents the dead token and the connection is marked `expired`. Every Zoom connection breaks within ~2 hours of its first refresh; transcript auto-save silently stops until manual reconnect.

### C2. Orphan migration: `zoom_connections.scopeVersion` never runs — fresh deployments break Zoom entirely
`packages/db/drizzle/0138_magical_may_parker.sql` (on disk, **absent from `meta/_journal.json`**; the journal's 0138 entry is `0138_workable_raider` — a numbering collision: 217 SQL files vs 214 journal entries)

The migration runner executes only journal entries, so this file never runs. `packages/db/src/schema/zoom.ts:40` declares the column and `apps/web/src/app/api/integrations/zoom/callback/route.ts:135,147` writes it; relational reads select all columns. Any environment migrated from the journal (fresh onprem/tenant installs) fails every Zoom OAuth connect and every `zoomConnections` read with Postgres 42703 `column does not exist`. This is exactly the drift the "never hand-edit `drizzle/`" rule exists to prevent. Related cleanup: `0073_lonely_johnny_blaze.sql` and `0110_opposite_santa_claus.sql` are dead orphan duplicates; note the `0110_` prefix collision.

---

## High — security

### S1. Page share-link redemption grants full drive membership (privilege escalation)
`packages/lib/src/permissions/share-link-service.ts:399-408`, interacting with "Rule 4" in `packages/lib/src/permissions/permissions.ts:245-251,1080-1088`

Redeeming a *page* share link unconditionally inserts a `driveMembers` row (`role: 'MEMBER'`, `acceptedAt: now`) in addition to the page-scoped grant. Any accepted drive member automatically gets `canView` on every non-private page in the drive (pages default `isPrivate = false`, `packages/db/src/schema/core.ts:83`). So a link intended to share ONE page grants read access to the entire drive's non-private pages. If membership is wanted for sidebar UX, it must not trigger Rule-4 visibility.

### S2. Pending (never-accepted) drive memberships honored by three routes
The codebase already fixed this class once (bulk-move, `apps/web/src/app/api/pages/bulk-move/route.ts:76-86` — "Review C2"), but three inline re-implementations omit the `acceptedAt IS NOT NULL` gate that every centralized permission function enforces:

- **`/api/messages/threads`** — `apps/web/src/app/api/messages/threads/route.ts:149-195` rolls its own raw-SQL filter; a pending invitee receives every channel in the drive: titles, unread counts, and the content of each channel's last message.
- **`/api/pages/reorder`** — `apps/web/src/services/api/page-reorder-service.ts:84-103`; a pending ADMIN can move/reparent any page in the drive.
- **Role-permission mutations** — `apps/web/src/services/api/permission-management-service.ts:105-131` (via PUT/DELETE `/api/pages/[pageId]/role-permissions`); a pending ADMIN can grant/revoke role-based page permissions — a permission-granting primitive, before ever accepting membership.

All three should call `isDriveOwnerOrAdmin` / centralized helpers instead of inline queries. (Five more routes roll their own logic that is currently correct — see "Rule-violation inventory" below — same drift risk.)

### S3. Session revocation never reaches live Socket.IO connections
`apps/realtime/src/index.ts:838-916` (auth only at handshake); `session_revoked` kick reason defined on all three sides (`apps/realtime/src/kick-handler.ts:18`, `apps/web/src/lib/websocket/socket-utils.ts:21`, `apps/web/src/hooks/useAccessRevocation.ts:72`) but **no server code ever sends it**

Logout-everywhere / stolen-token invalidation / admin revoke never disconnects existing sockets. A revoked session keeps receiving DMs, notifications, and task/calendar events indefinitely, and can re-join page rooms (join re-checks page permissions, not session validity). The kick path also only removes rooms — it never `socket.disconnect()`s. The `session_revoked` contract is dead code on all three sides — wiring that looks complete but is inert.

### S4. Share-link tokens stored and looked up in plaintext at rest
`packages/db/src/schema/share-links.ts:13,40`; `packages/lib/src/permissions/share-link-service.ts:216,382,472`

Every other bearer credential in the system (invite tokens, form tokens, MCP tokens, OAuth codes/refresh tokens) is stored as a SHA3-256 hash. Share-link tokens — which grant up to drive ADMIN — are raw values resolved by plaintext equality. Any DB-read exposure (backup leak, replica, over-broad support query) yields working share URLs. Add a `tokenHash` column, look up by hash.

### S5. Page-presence identities broadcast to the whole drive room, bypassing page permissions
`apps/realtime/src/index.ts:1256-1259,1293-1298,1409-1414`

`presence:page_viewers` payloads (viewer names/avatars + pageId) go to `drive:${driveId}`, which requires only drive access. A member without access to a private page learns in real time who is reading it.

Lower-severity security items: realtime CORS reflects any origin when no origins configured (`apps/realtime/src/index.ts:789-802`, dev/misconfig only); realtime internal HTTP endpoints buffer unbounded bodies before HMAC check (`index.ts:659-663,726-729,766-769` — OOM DoS if the port is exposed directly, e.g. Fly); `x-forwarded-for` trusted for rate-limit keying outside Fly topology (`apps/web/src/lib/security/edge-client-ip.ts:41-42`); user-supplied regex reaches Postgres `~` (authenticated CPU DoS, `api/drives/[driveId]/search/regex/route.ts:102-114`); unauthenticated tenant-slug oracle (`api/provisioning-status/[slug]`); admin health endpoint leaks heap/pool stats unauthenticated (`apps/admin/src/app/api/health/route.ts`).

---

## High — outright failures & half-wired features

### F1. Tenant mode ships with all server-side realtime broadcasts silently dead
`infrastructure/docker-compose.tenant.yml:180-235` and `infrastructure/env.tenant.template` never set `INTERNAL_REALTIME_URL`; every broadcast helper (`apps/web/src/lib/websocket/socket-utils.ts:187` et al.) silently returns when it's unset

Clients connect to Socket.IO fine, but no page/task/chat/notification/kick event is ever pushed from web in any tenant deployment. The permission-revocation kick also no-ops, extending stale-permission windows to next reconnect. Evidence is a warn-level log only.

### F2. The crash-prevention fix itself silently truncates task boards at 100 tasks
Server: `apps/web/src/app/api/pages/[pageId]/tasks/route.ts:109,154-166` (added in 86f76f3) clamps to limit 100/200 but returns no `total`/`hasMore`/cursor. Client: `TaskListView.tsx:472-481` fetches with no limit/offset and has zero load-more logic.

Boards with >100 tasks silently show the first 100; client-side search over the truncated set reports "no results" for existing tasks; drag-reorder computes positions from the truncated array and can interleave wrongly with unseen tasks. The OOM crash became silent data invisibility. (The sibling `/api/tasks` + `TasksDashboard.tsx` pair does this correctly.)

### F3. Unbounded-query OOM class survives on hotter routes than the one that crashed
The lint backstop (`apps/web/eslint.config.mjs:20-25`) only covers relational `findMany` inside `apps/web`; raw `db.select()` chains and all of `packages/lib`/`packages/db`/`apps/admin` are invisible to it, and 82 suppressed call sites remain. Live instances on unboundedly-growing message tables:

- `apps/web/src/services/api/page-service.ts:396,506` — full `chatMessages` history with user join on **GET/PATCH `/api/pages/[pageId]`** (fires on opening any page).
- `apps/web/src/app/api/ai/chat/route.ts:1201` — raw select of the entire conversation on **every AI chat turn**.
- `apps/web/src/lib/ai/tools/page-read-tools.ts:577` and `api/mcp/documents/route.ts:402` — full channel transcript with per-row decrypt when an agent/MCP reads a CHANNEL page.
- `api/ai/page-agents/consult/route.ts:290` — unbounded conversation load (the sibling branch at :305 is correctly `.limit(10)`).
- Whole-drive `pages` scans (suppressed): `pages/tree/route.ts:85`, `drives/[driveId]/pages/route.ts:83,133,164`, `trash/route.ts:80` (with children fanout).

### F4. `drives.aiProvider`/`aiModel`: accepted by the API, validated, returned 200 — and never persisted anywhere
PATCH `/api/drives/[driveId]` validates both fields (`route.ts:22-23`) but never passes them to `updateDrive`; `packages/lib/src/services/drive-service.ts` has zero references to either field; the schema columns (`packages/db/src/schema/core.ts:46-47`) are read by GET but written by nothing. A user sets a drive-level AI default, gets 200 OK, nothing persists. The test at `route.test.ts:470-487` asserts only `status === 200`, so it passes while the fields are discarded — false confidence.

### F5. Stripe checkout provisioning is non-idempotent with an absorbing failure state
`apps/control-plane/src/routes/stripe-webhooks.ts:103-126`; `apps/control-plane/src/services/provisioning-engine.ts:64-76,146-168`

No `event.id` dedup. `provision()` then `updateTenantStripeIds()` are two separate writes: if the second throws, Stripe retries hit "slug already exists" forever and the tenant runs with **no Stripe linkage** — `subscription.deleted`/`invoice.payment_failed` can never find it (permanent revenue leak). Any mid-provision crash leaves `status: 'failed'` with the slug claimed and no requeue/repair path — manual DB surgery required.

### F6. Realtime inbox updates are dead: socket handler mutates SWR keys nothing fetches
`apps/web/src/hooks/useInboxSocket.ts:31-35` writes to `/api/inbox?driveId=...&limit=20` / `/api/inbox?limit=20`; every consumer (`DMSidebar.tsx:33`, `ChannelsSidebar.tsx:55-58`, `DMCenterList.tsx`, `ChannelsCenterList.tsx`) fetches **typed** keys (`?type=dm...`/`?type=channel...`). All `inbox:*` cache writes land in phantom entries; with `refreshInterval: 0` and `revalidateOnFocus: false`, unread badges and previews never update live — only on remount.

### F7. Dead event wiring that looks functional in review
- `task:task_list_created`: listeners in `MessageRenderer.tsx:236`/`CompactMessageRenderer.tsx:233` (with proper cleanup — looks complete); no producer ever emits it. AI-created task lists never live-update.
- `device:added`/`device:revoked`/`device:warning`: listeners in `components/devices/DeviceList.tsx:45-47`; zero producers. A security surface that never live-updates.
- Client emits `join`/`leave` (`useGlobalDriveSocket.ts:76,118`) that realtime has no handler for — masked by server auto-join (`apps/realtime/src/index.ts:932-944`); `leave` never happens, and any auto-join change breaks drive sync with zero errors.
- `document_update` relay (`index.ts:1315-1325`): authenticated write-relay with zero producers/consumers. `validation_error` and per-event-auth `error` events are emitted but no client listens — denials fail invisibly.
- `/api/pages/[pageId]/tasks/reorder`: zero callers; writes `taskItems.position`, which the GET orders past via `coalesce(pages.position, ...)` where `pages.position` is NOT NULL — a written-never-read column. Also updates body-supplied task ids with no page-ownership scoping. Delete or fix.
- `text-extract` pg-boss queue + registered worker: only producer is a test; production runs extraction inline in `ingest-file`.
- `clearPendingAbort` (`apps/web/src/lib/ai/core/pending-abort-intents.ts:129-152`): docblock says "called when a stream completes normally"; only callers are tests. The orphaned-intent window it was written to close (Stop during preflight + failed send → next send silently pre-aborted for 30s) is real.

### F8. Security-critical test suites exist but silently never run in CI
~14 integration suites gated by `describe.skipIf` on env vars CI never sets (`ADMIN_DATABASE_URL`, ClickHouse): DB zero-trust grants, audit-chain immutability (`apps/processor/.../audit-chainer-worker.integration.test.ts:119`), GDPR eraser, SIEM delivery, admin partitioning. `.github/workflows/ci.yml:58-81` sets only `DATABASE_URL`. Skipped suites report green. Separately, `ci.yml:84-91` runs `scripts/__tests__` from a hand-maintained 9-file list, with an in-workflow comment admitting other suites are broken; never-run files include token-migration verification and PII-encryption backfill tests.

---

## High — AI streaming layer (the churn epicenter)

### A1. Cross-surface stream wipe: unmount cleanup destroys a co-mounted sibling's live streams
`apps/web/src/hooks/useChannelStreamSocket.ts:703-722` cleanup calls `clearPageStreams(channelId)`, wiping the *entire channel's* entries from the shared `usePendingStreamsStore` — but two hook instances legitimately co-mount on one channel (AiChatView + SidebarChatTab in agent mode, via `useAgentChannelMultiplayer`; co-mounting is designed-for per `bootstrapConsumerGuard.ts`). Unmounting one destroys entries the survivor is rendering; `applyAppendPart.ts:9-13` then silently no-ops all further SSE parts. Bootstrapped/remote streams have no repair path until a best-effort `chat:stream_complete` or socket reconnect; the wiped conversation also loses SWR/auth-refresh protection mid-stream. Same class as the #2121 mis-keying fix.

### A2. Global assistant route lacks the mid-stream credit-exhaustion abort the chat route has
`api/ai/global/[id]/messages/route.ts:404-438,1243-1277` places a credit hold but never enforces it mid-run; `makeOnStepFinishHandler` (`api/ai/chat/step-finish-handler.ts`) has exactly one consumer (the chat route). A near-zero-balance user can run a long agent (300s, max steps) past the reserve; settle drives the balance negative. The identical run through `/api/ai/chat` aborts at the step boundary.

### A3. Chat message editors violate the `useEditingStore` contract
`MessageRenderer.tsx:155` / `CompactMessageRenderer.tsx:152` render `MessageEditor` with local `isEditing` state and never register. `isAnyEditing()` reports false during a message edit, so `canResumeRecovery` (SidebarChatTab:892-894, AiChatView:1267) fires `reloadCurrentConversation()` on resume/reconnect and the unsaved draft can be discarded.

Medium/low in this layer: the SSE done-sentinel's `aborted` flag is parsed then discarded by its only consumer, with a docblock asserting the information doesn't exist (`stream-join-client.ts:22-24,83` vs `useChannelStreamSocket.ts:315-327,67-74` — interrupted replies badge as complete if the best-effort socket event is lost); `useAnswerAskUser` re-reads nothing after its up-to-1.5s await — the exact stale-capture class #2121 fixed in `useCacheMessageActions` (`useAnswerAskUser.ts:97-125`); `stream-join-poll-fallback.ts:49-70` polls forever on persistent non-ok responses; vision-capability gate checks the *claimed* model, not the resolved one (both AI routes — omit `selectedModel` and images reach non-vision models); duplicate static+dynamic import of `rate-limit-middleware` in the chat route (:24 vs :761); `stream-abort-registry.ts:119-134` starts an eternal un-unref'd interval, contradicting the file's own stated policy.

---

## High — frontend data-loss bugs

### D1. `usePageContent` can write one page's content into another page
`apps/web/src/hooks/usePageContent.ts:73-90` — the unmount/pageId-change cleanup force-saves `pendingContentRef` but never clears it; only `performSave` does. Via `TaskDetailSheet.tsx:91-95`: type in task A's description, switch the sheet to task B within the debounce window, close without touching B → second cleanup PATCHes **A's content onto B**. Server-side data corruption from a UI hook.

### D2. Notification listeners: blanket `off()` clobbers siblings; double-registration duplicates
`stores/useNotificationStore.ts:185-203` — `cleanupSocketListeners()` calls `socket.off('notification:new')` with no handler argument. Both `NotificationBell` (TopBar) and `/notifications` register. On `/notifications`, every notification is added twice (duplicate ids, unread +2); navigating away strips the Bell's listener too — realtime notifications silently stop until the next connection-status change. The comment in `useNotificationToasts.tsx:16-21` claiming a single registrar is already false.

### D3. Mid-edit clobber cluster (the `useEditingStore` contract is widely unenforced)
- `EditableTitle.tsx:28-32` — the flagship rename input resets to the server title on any tree revalidation while the user is typing; the `usePageTree` deferral guard can't engage because the component never registers.
- `WorkflowForm.tsx:120-132` + `WorkflowsDashboard.tsx:129-143` — reset effect keyed on an inline-literal `initialData` rebuilt every render; any dashboard re-render (5-min refresh, socket workflow event) wipes in-progress dialog edits.
- `app/settings/personalization/page.tsx:34-37,55-62` — no global SWRConfig, so `revalidateOnFocus` is on; init effect ignores `isDirty`; tab away and back wipes the form.
- Also unregistered: TaskDetailSheet, settings/account, RoleEditor, DriveAISettings, CommandFormDialog, RenameDialog and friends. (Correctly registered, for contrast: DocumentView, CodePageView, SheetView, CanvasPageView, ChannelInput, MessageInput, ThreadPanel, TaskListDescription, EventModal, XtermTerminal, FilesFilePane, drive-settings general page.)

### D4. Other verified frontend defects
- `ThreadPanel.tsx:516-559` — optimistic edit/delete with no rollback (the same file's reaction/follow handlers roll back correctly; this pair drifted).
- `useSocketStore.ts:42-57,206-209` — async `connect()` with no in-flight guard; two rapid calls leak a zombie socket with live retry timers.
- Calendar tasks: server filters by `createdAt` (`api/tasks/route.ts:268-275`) while the calendar buckets by `dueDate` (`useCalendarData.ts:89-100`, `calendar-types.ts:251-256`) — long-lead tasks silently never appear on the calendar; dense months also truncate (no limit sent, `hasMore` ignored).
- Two persisted tab stores (`useOpenTabsStore.ts` 287 lines vs `useTabsStore.ts` 362 lines) — near-duplicate copy-paste; the former's only non-test consumer is a write in `EditableTitle.tsx:63`; nothing renders from it. Write-only dead weight persisted to every user's localStorage.

---

## Medium — background services & integrations

- **OAuth refresh has no serialization** (`zoom/token-refresh.ts:64-126`, `google-calendar/token-refresh.ts:100-171`): no lock, no write predicate; any refresh error — including 429/network — unconditionally writes `expired`/`requiresReauth`. The platform's own OAuth server does it right (`oauth-repository.ts:476-601`, transaction + FOR UPDATE); the integrations paths adopted none of it.
- **HTTP executor auto-retries non-idempotent writes** (`packages/lib/src/integrations/execution/http-executor.ts:93-232`): POSTs to GitHub/Slack/Notion retried up to 4× on 5xx/network with no idempotency keys → duplicate posts as the user. Compounded by `saga/execute-tool.ts:285-298`: audit-log insert after the external write; if it throws, the tool reports failure and the agent retries the landed write. Also `Retry-After` parsed as seconds only → `setTimeout(NaN)` → immediate retry (`http-executor.ts:154-157`).
- **Generic integrations framework never refreshes or revokes tokens**: `refreshOAuthToken` has zero production call sites; `execute-tool.ts:198-204` applies tokens without checking `expiresAt`; every provider defines `revokeUrl` but nothing reads it — disconnecting leaves live tokens at the provider. `updateConnectionLastUsed` never called (settings UI shows "never used" forever).
- **Slack/Notion pagination unreachable**: tools accept a cursor input but `outputTransform` discards `next_cursor`/`has_more` (`providers/slack.ts:79,133`, `notion.ts:96-105`). Agents silently reason over one page of data.
- **Processor**: `pull-verify` swallows all failures and pg-boss records success (`s3-pull-adapter.ts:65-99`, `queue-manager.ts:241-248` `return { success: true }` unconditionally — transient S3/DB blips become permanent `failed` pages); originals buffered fully in memory up to 2 GB inside a memory-capped container (OOM-retry loop for the same file); no execution timeout on pdfjs/Tesseract → pg-boss 15-min expiration double-processes while the hung handler still runs; `/health` cannot report unhealthy (`server.ts:164-190`) while realtime has no health endpoint at all.
- **Sandbox concurrency caps are per-process fiction** (`packages/lib/src/services/sandbox/quota.ts:30-77`, commit 40da3a5): module-level Map loaded by both web and realtime and every replica — true ceiling is `limit × process count`; the "live concurrency view" counts a different thing (credit holds) than the gate enforces. The stated cost ceiling doesn't exist across replicas.
- **Task board GET is impure**: the CSRF-exempt read path performs writes (list creation, status seeding, backfill) via a duplicated get-or-create that diverges from the documented single-source `task-sync-service.ts`, with unique-violation detection by `message.includes('unique')` instead of pg code 23505 (`api/pages/[pageId]/tasks/route.ts:27-79,70-73,147`).
- **N+1 hot paths**: `drives/[driveId]/assignees` runs `canUserViewPage` per agent page; `account/drives-status` runs count + admin query per owned drive; `mcp/drives` two queries per scoped drive; `commands/resolve` membership check per command on client-unbounded ids; channel message send view-checks per mention.
- **Backup preview swallows S3 failures** (`api/backups/[backupId]/pages/route.ts:71-73` + duplicate): a transient blip renders a backup as blank — indistinguishable from empty — to a user deciding whether to restore.
- **Realtime misc**: `join_channel` denial disconnects the entire socket (`index.ts:971,975`) vs siblings that just decline; `presence:leave_page` unauthenticated re-broadcast spam; terminal input cap counts UTF-16 units not bytes (~3× intended 4 KB).

---

## Medium — hygiene, enforcement, slop

- **"No `any`" rule is convention-only**: no eslint config enables `@typescript-eslint/no-explicit-any`; the 6 file-wide disables suppress a rule that was never on. Worst live erosion: `as unknown as` double-casts on attacker-supplied WebAuthn payloads in the passkey/step-up core (`packages/lib/src/auth/passkey-service.ts:322,352,529,903,957`, `step-up-service.ts:200`) — no structural validation before SimpleWebAuthn; `(result as any).rowCount ?? 0` in device-token revocation accounting (`device-auth-utils.ts:119,257,282`) silently zeroes if the driver shape changes; `or(...)!` in `user-repository.ts:84,117` where a collapsed WHERE would match every user row.
- **`process.env.OAUTH_STATE_SECRET!`** fed to HMAC in 4 OAuth connect/callback routes — unset env means state validation built on a forced-undefined secret on an attacker-reachable surface.
- **Lint warnings non-blocking** (`apps/web/package.json:9`, no `--max-warnings 0`) — self-documented in the eslint config as having already masked a real missing-dep bug; `test.yml` triggers only on PRs to 4 named branches — other base branches get zero CI.
- **`changelog:generate` is broken**: `package.json:40` points at `scripts/changelog/index.ts`, which does not exist — CLAUDE.md instructs every contributor to run it.
- **Duplicate utilities**: `formatBytes` ×6, `slugify` ×3 (one dead, one private API-route copy), relative-time formatting ×7, hand-rolled debounce ×7, `truncateDiffContent` ×2. Knip is configured but not run in CI.
- **Dead code**: full custom-integration authoring UI unreachable (`ToolBuilder.tsx`, `OpenAPIImportDialog.tsx`, `IntegrationAuditLogPage.tsx` — API routes exist, UI unwired); `DriveList.tsx`, `workspace-selector.tsx`, `SidebarSettingsTab.tsx`, `ContactForm.tsx`, `TaskMobileCard.tsx`, misc ui/; six one-off codemods in `scripts/`; `getLanguageFromPath` duplicate; `task_completed` and `page:deleted` dead event enum members.
- **Fake/vacuous tests**: google-calendar deployment-mode gate tests assert only inside `if (status === 404)` and the 8 "tenant mode" tests never set tenant mode (byte-identical to cloud tests); `expect(true).toBe(true)` in `ws-connections.test.ts:373-392` and conditional tautologies in `useCapacitor.test.ts:258-284`; `drives/[driveId]/route.test.ts:470-487` asserts 200 while the fields under test are silently dropped (see F4); processor `expectTypeOf` files pass unconditionally at runtime.
- **Deps skew**: `pdfjs-dist` 5.x (web) vs 4.x (processor) parsing the same user PDFs; eslint 9 vs 10; recharts 3 vs 2; dotenv 17 vs 16.
- **Compliance surface**: four route groups allow-listed out of SecurityAudit logging with "TODO: follow-up PR" (`security-audit-coverage.test.ts:102-153`); Android `assetlinks.json` still `TODO:ADD_SHA256_FINGERPRINT`; FCM/Web Push stubs return `success:false`; ~40 `[TODO]` placeholders render on the public subprocessors/GDPR pages.
- **Migration hygiene**: 11 journaled hand-written migrations lack meta snapshots, several destructive (TRUNCATE `security_audit_log`, DELETEs) with guards only in comments.

## Rule-violation inventory (correct today, drift-prone)
Routes rolling their own permission logic instead of `packages/lib/src/permissions/` (the exact pattern that produced S2): `drives/[driveId]/permissions-tree/route.ts:49-68`, `drives/[driveId]/pages/route.ts:20-62`, `trash/drives/[driveId]/route.ts:30-38`, `drives/[driveId]/restore/route.ts:46-55`, `members/invite/route.ts:103-116`.

## Verified strengths (checked, clean)
Webhook signature verification everywhere (Stripe raw-body, Zoom HMAC+replay window, Google Calendar zero-trust); OAuth 2.1 server (PKCE S256, exact redirect match, hashed single-use codes, rotation with reuse detection); timing-safe secret compares; AES-256-GCM fresh-IV encryption + HMAC blind index; session cookies hardened; no SQLi, no `!isCloud()` misuse, no async-params bugs, no header-trust identity; processor path handling traversal-safe with `execFile`+timeouts; agent-terminal subsystem rigorous; email-broadcast/account-erasure workers properly idempotent; backfill scripts dry-run+batched; core CI genuinely blocking (no `continue-on-error`); zero `.only`, zero `@ts-ignore`; the heavily-mocked AI route tests exercise real handlers.

## Top 10 recommended actions
1. Fix Zoom refresh-token rotation + serialize integration token refresh (C1, and the H5 class).
2. Re-journal or regenerate migration 0138; add a CI check that `drizzle/*.sql` ⊆ journal (C2).
3. Stop granting drive membership on page-share redemption; add `acceptedAt` gates via centralized helpers in the three pending-member routes (S1, S2).
4. Wire `INTERNAL_REALTIME_URL` into tenant compose/env; add a startup assertion that fails loudly when broadcasts are unconfigured (F1).
5. Add pagination (server `hasMore` + client load-more) to the page-tasks board; bound the chat/channel history loads (F2, F3) and extend the findMany lint rule to packages/lib, packages/db, apps/admin, and raw select chains.
6. Wire `drives.aiProvider`/`aiModel` through `updateDrive` (or remove the fields end-to-end) and make the test assert persistence (F4).
7. Add Stripe `event.id` dedup + idempotent/resumable provisioning (F5).
8. Fix `useInboxSocket` key mismatch; scope `clearPageStreams` to the owning instance; clear `pendingContentRef` in the `usePageContent` cleanup; pass handler refs to `socket.off` in the notification store (F6, A1, D1, D2).
9. Register the unregistered editors with `useEditingStore` (chat message editors, EditableTitle, WorkflowForm, settings forms) and consider an eslint guard for the contract (A3, D3).
10. Set `ADMIN_DATABASE_URL`/ClickHouse in CI so the security suites actually run; enable `@typescript-eslint/no-explicit-any`; add `--max-warnings 0`; fix or delete `changelog:generate` (F8, hygiene).
