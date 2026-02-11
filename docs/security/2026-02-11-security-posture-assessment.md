# PageSpace Security Posture Assessment
Date: February 11, 2026  
Scope: `apps/web`, `apps/processor`, `packages/lib`, `packages/db`, desktop MCP trust model docs

## Executive Summary
Your proposed statement is directionally right, but not fully true as written.

What is true now:
- Authenticated web/service operations are largely built around opaque server-issued tokens and server-side revalidation.
- Session tokens are hashed at rest and revalidated against DB state (expiry, revocation, suspension, token version) on each use.
- CSRF/origin protections and scoped service tokens exist and are implemented in core auth paths.

What is not true now:
- Not every endpoint is session-mediated (by design: health, webhooks, monitoring ingest, unsubscribe links, etc.).
- Scoped MCP token restrictions are not consistently enforced across hybrid (`session` + `mcp`) routes.
- A suspended user can still authenticate with existing MCP tokens (suspension check is present for sessions, not MCP token validation).
- Page/chat content is plaintext at the application layer (intentional tradeoff for search/AI workflows).

## Can You Publish This Exact Claim?
Claim draft:
> "PageSpace treats every request as untrusted. All access is mediated by opaque, server-issued sessions, and the server re-validates identity + permissions on every operation."

Recommendation: Do not publish this exact wording yet.

Use this instead:
> "PageSpace treats network requests as untrusted. Authenticated operations are mediated by opaque server-issued tokens (session, service, or MCP), and the server re-validates identity and authorization on each operation. We explicitly document exceptions for local desktop MCP servers and plaintext searchable content."

## Verified Security Controls
1. Opaque token model with server-side lookup:
- Session creation/validation: `packages/lib/src/auth/session-service.ts:38`, `packages/lib/src/auth/session-service.ts:76`
- Session hash storage: `packages/db/src/schema/sessions.ts:10`
- Session revocation + token version invalidation: `packages/lib/src/auth/session-service.ts:105`
- Suspension invalidation for session tokens: `packages/lib/src/auth/session-service.ts:99`

2. Centralized request auth plumbing:
- Auth dispatcher for session/MCP: `apps/web/src/lib/auth/index.ts:241`
- MCP token hash lookup: `apps/web/src/lib/auth/index.ts:63`
- Bearer/cookie session handling: `apps/web/src/lib/auth/index.ts:166`

3. CSRF and origin protections (session cookie flows):
- Cookie hardening (`httpOnly`, `sameSite: 'strict'`): `apps/web/src/lib/auth/cookie-config.ts:40`
- CSRF validates against server-validated session ID: `apps/web/src/lib/auth/csrf-validation.ts:92`

4. Scoped service tokens for processor:
- Processor service-only token enforcement: `apps/processor/src/middleware/auth.ts:70`
- Per-route scope enforcement: `apps/processor/src/middleware/auth.ts:112`
- Scope gates mounted on processor routes: `apps/processor/src/server.ts:48`

## Intentional Exceptions and Tradeoffs
1. Local desktop MCP servers are trust-based (user liability model):
- Trust model explicitly documented: `docs/security/desktop-mcp-trust-model.md:5`
- No sandboxing stated in implementation comments: `apps/desktop/src/main/mcp-manager.ts:76`

2. Content is plaintext at app layer for search/AI:
- Page content stored as plaintext text field: `packages/db/src/schema/core.ts:30`
- Chat message content stored as plaintext text field: `packages/db/src/schema/core.ts:78`
- Search reads `pages.content`: `apps/web/src/app/api/search/route.ts:301`
- Tradeoff documented: `docs/security/compliance-sovereignty-analysis.md:34`

3. Non-session auth/public endpoints (expected):
- Health endpoint: `apps/web/src/app/api/health/route.ts:29`
- Public compiled CSS endpoint: `apps/web/src/app/api/compiled-css/route.ts:6`
- Stripe webhook signature auth: `apps/web/src/app/api/stripe/webhook/route.ts:16`
- Monitoring ingest shared key auth: `apps/web/src/app/api/internal/monitoring/ingest/route.ts:48`
- Cron signed/internal auth: `apps/web/src/lib/auth/cron-auth.ts:100`
- One-time unsubscribe token flow: `apps/web/src/app/api/notifications/unsubscribe/[token]/route.ts:42`

## Security Gaps / Bugs
### P1: Scoped MCP token bypass across hybrid API routes
Risk vector:
- Many routes accept `allow: ['session', 'mcp']` but do not enforce MCP drive/page scope.
- They authorize based on user membership/permissions only, so a scoped MCP token can operate outside intended scope.

Representative evidence:
- Multi-drive search accepts MCP and queries all user-accessible drives:
  - `apps/web/src/app/api/search/multi-drive/route.ts:8`
  - `apps/web/src/app/api/search/multi-drive/route.ts:44`
- Page tree route accepts MCP and checks user membership, not MCP token scope:
  - `apps/web/src/app/api/pages/tree/route.ts:8`
  - `apps/web/src/app/api/pages/tree/route.ts:43`
- Markdown export route accepts MCP and only checks `canUserViewPage`:
  - `apps/web/src/app/api/pages/[pageId]/export/markdown/route.ts:10`
  - `apps/web/src/app/api/pages/[pageId]/export/markdown/route.ts:28`
- Activities APIs accept MCP and use user-level checks only:
  - `apps/web/src/app/api/activities/route.ts:8`
  - `apps/web/src/app/api/activities/export/route.ts:10`
- Upload accepts MCP and issues upload service token without MCP scope gate:
  - `apps/web/src/app/api/upload/route.ts:36`
  - `apps/web/src/app/api/upload/route.ts:146`

Quantified blast radius:
- 47 hybrid routes found; 13 do not directly call MCP scope helper functions (`checkMCPDriveScope`, `checkMCPPageScope`, `filterDrivesByMCPScope`, `checkMCPCreateScope`, `getAllowedDriveIds`).
- 17 routes were fixed in PR #553 (see Appendix A for details).

### P1: Suspended users can still use MCP tokens
Risk vector:
- Session validation blocks suspended users and revokes sessions.
- MCP token validation does not check `suspendedAt`, so suspended accounts retain MCP API access until token revocation.

Evidence:
- Session suspension enforcement: `packages/lib/src/auth/session-service.ts:99`
- MCP token validation path lacks suspension check and returns auth details: `apps/web/src/lib/auth/index.ts:63`

### P1: Processor file-delete endpoint lacks resource ownership authorization
Risk vector:
- Delete endpoint validates only content hash + scope.
- No RBAC check ties delete request to authorized page/file ownership.
- Any valid `files:delete` service token can attempt deletes by known hash.

Evidence:
- Delete route: `apps/processor/src/api/delete-file.ts:12`
- Mounted only behind `files:delete` scope: `apps/processor/src/server.ts:52`
- Read endpoints do enforce file RBAC (contrast): `apps/processor/src/api/serve.ts:32`, `apps/processor/src/api/serve.ts:149`

### P2: Admin role-version bypass in gift subscription admin endpoint
Risk vector:
- Endpoint checks `auth.role === 'admin'` but does not run `verifyAdminAuth`.
- If role changes and session remains valid, this endpoint may allow stale-admin access until session invalidation.

Evidence:
- Role-only checks: `apps/web/src/app/api/admin/users/[userId]/gift-subscription/route.ts:30`, `apps/web/src/app/api/admin/users/[userId]/gift-subscription/route.ts:183`
- Stronger validation exists (`adminRoleVersion`): `apps/web/src/lib/auth/auth.ts:30`

## Risk Register (Public Blog Transparency)
1. Local MCP server execution model: user-trusted local code execution, not sandboxed.
2. Plaintext searchable content: no app-layer content encryption for pages/chat.
3. Hybrid MCP scope inconsistency: scoped tokens may exceed intended drive boundaries.
4. MCP suspension gap: suspended users may retain MCP token access.
5. Processor hash-delete authorization gap: delete by hash lacks ownership check.
6. Admin stale-role path in one endpoint: bypasses role-version hardening model.

## Remediation Priority
1. Enforce MCP scope checks in all hybrid routes (or deny MCP by default unless explicit scope guard is present).
2. Add suspension enforcement to `validateMCPToken`.
3. Add ownership/resource authorization in `apps/processor/src/api/delete-file.ts` (match serve RBAC pattern).
4. Migrate `gift-subscription` route to `verifyAdminAuth`.
5. Add automated tests:
- Route-level MCP scope tests for all hybrid routes.
- Suspension test for MCP token auth.
- Processor delete authorization test.

## Appendix A: MCP Scope Enforcement Status

### Routes Fixed in PR #553 (17)
These routes now call MCP scope helper functions:
- `apps/web/src/app/api/upload/route.ts` - uses `checkMCPCreateScope`
- `apps/web/src/app/api/search/multi-drive/route.ts` - uses `filterDrivesByMCPScope`
- `apps/web/src/app/api/activities/export/route.ts` - uses `checkMCPDriveScope`, `checkMCPPageScope`, `getAllowedDriveIds`
- `apps/web/src/app/api/activities/route.ts` - uses `checkMCPDriveScope`, `checkMCPPageScope`, `getAllowedDriveIds`
- `apps/web/src/app/api/activities/actors/route.ts` - uses `checkMCPDriveScope`, `getAllowedDriveIds`
- `apps/web/src/app/api/pages/tree/route.ts` - uses `checkMCPDriveScope`
- `apps/web/src/app/api/pages/reorder/route.ts` - uses `checkMCPDriveScope`
- `apps/web/src/app/api/pages/[pageId]/export/markdown/route.ts` - uses `checkMCPPageScope`
- `apps/web/src/app/api/pages/[pageId]/export/docx/route.ts` - uses `checkMCPPageScope`
- `apps/web/src/app/api/pages/[pageId]/export/csv/route.ts` - uses `checkMCPPageScope`
- `apps/web/src/app/api/pages/[pageId]/export/xlsx/route.ts` - uses `checkMCPPageScope`
- `apps/web/src/app/api/pages/[pageId]/history/route.ts` - uses `checkMCPPageScope`
- `apps/web/src/app/api/pages/[pageId]/restore/route.ts` - uses `checkMCPPageScope`
- `apps/web/src/app/api/pages/[pageId]/versions/compare/route.ts` - uses `checkMCPPageScope`
- `apps/web/src/app/api/pages/[pageId]/agent-config/route.ts` - uses `checkMCPPageScope`
- `apps/web/src/app/api/drives/[driveId]/restore/route.ts` - uses `checkMCPDriveScope`
- `apps/web/src/app/api/drives/[driveId]/access/route.ts` - uses `checkMCPDriveScope`

### Routes Still Outstanding (13)
These routes accept MCP tokens but do not directly call MCP scope helpers:
- `apps/web/src/app/api/calendar/events/[eventId]/route.ts`
- `apps/web/src/app/api/calendar/events/[eventId]/attendees/route.ts`
- `apps/web/src/app/api/activities/[activityId]/route.ts`
- `apps/web/src/app/api/calendar/events/route.ts`
- `apps/web/src/app/api/ai/chat/messages/[messageId]/route.ts`
- `apps/web/src/app/api/ai/page-agents/[agentId]/conversations/[conversationId]/route.ts`
- `apps/web/src/app/api/drives/[driveId]/trash/route.ts`
- `apps/web/src/app/api/ai/chat/messages/[messageId]/undo/route.ts`
- `apps/web/src/app/api/ai/page-agents/consult/route.ts`
- `apps/web/src/app/api/pages/[pageId]/tasks/[taskId]/route.ts`
- `apps/web/src/app/api/ai/page-agents/[agentId]/conversations/[conversationId]/messages/[messageId]/route.ts`
- `apps/web/src/app/api/ai/page-agents/[agentId]/conversations/[conversationId]/messages/route.ts`
- `apps/web/src/app/api/ai/page-agents/[agentId]/conversations/route.ts`
