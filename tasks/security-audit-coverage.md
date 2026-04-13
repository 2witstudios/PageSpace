# Epic: SecurityAuditService Complete Route Coverage

**Status**: In Progress
**Created**: 2026-04-10
**Goal**: Wire SecurityAuditService into all 248 API routes (currently ~38/248 = 15%)

## Context

SecurityAuditService (`packages/lib/src/audit/security-audit.ts`) provides tamper-evident security event logging with hash chain integrity. PRs #868-870 wired it into auth/logout, pages, drives, permissions, settings, account, file upload, and export routes. The remaining ~210 routes need coverage to close the audit gap.

## Already Covered (38 routes)

| Domain | Coverage | Notes |
|--------|----------|-------|
| Account | 6/6 (100%) | Avatar, devices, export, handle-drive, profile |
| Settings | 4/4 (100%) | Display, hotkey, notification, personalization |
| Upload | 1/1 (100%) | File upload |
| Drives | 12/13 (92%) | All except one edge case |
| Pages | 16/28 (57%) | CRUD, exports, bulk ops, permissions, tasks |
| Auth | 1/32 (3%) | Only logout |

## Implementation Pattern

Use `auditRequest(req, event)` — it automatically extracts IP/user-agent from headers and dual-writes to both the structured logger and tamper-evident audit DB. Fire-and-forget with centralized `.catch()`.

```typescript
// Import
import { auditRequest } from '@pagespace/lib/server';

// After successful operation, before response
auditRequest(req, {
  eventType: 'auth.login.success',
  userId: user.id,
  sessionId: sessionClaims.sessionId,
  details: { method: 'Google OAuth' },
});
```

### Event Type Guide

| Operation | eventType | riskScore |
|-----------|-----------|-----------|
| Login success | `auth.login.success` | — |
| Login failure (invalid token) | `auth.login.failure` | 0.3 |
| Login failure (user cancel) | `auth.login.failure` | 0.1 |
| Rate limit exceeded | `security.rate.limited` | 0.5 |
| CSRF validation failure | `security.suspicious.activity` | 0.6 |
| Token refresh | `auth.token.refreshed` | — |
| Token created | `auth.token.created` | — |
| Token revoked | `auth.token.revoked` | — |
| Logout | `auth.logout` | — |
| Data read | `data.read` | — |
| Data write/create/update | `data.write` | — |
| Data delete | `data.delete` | — |
| Data export | `data.export` | — |
| Data share/invite | `data.share` | — |
| Access denied | `security.access.denied` | 0.5 |

## PR Plan (9 branches, 5 priority tiers)

### PR 1: `audit/auth-routes` — Auth Domain (31 routes) [CRITICAL]

OAuth callbacks, passkey operations, token exchanges, magic links, device auth, email verification. These are the highest-risk routes for security — authentication events are the #1 audit requirement.

**Routes (using `auditRequest` pattern):**
- [x] `/auth/apple/callback` — `auth.login.success`/`auth.login.failure`
- [x] `/auth/apple/native` — `auth.login.success`/`auth.login.failure`
- [x] `/auth/google/callback` — `auth.login.success`/`auth.login.failure`
- [x] `/auth/google/native` — `auth.login.success`/`auth.login.failure`
- [x] `/auth/google/one-tap` — `auth.login.success`/`auth.login.failure`
- [x] `/auth/mobile/oauth/google/exchange` — `auth.login.success`/`auth.login.failure`
- [x] `/auth/device/refresh` — `auth.token.refreshed`
- [x] `/auth/magic-link/verify` — `auth.login.success`/`auth.login.failure`
- [x] `/auth/logout` — `auth.logout`/`auth.token.revoked`
- [x] `/auth/signup-passkey` — `auth.login.success`/`auth.token.created`/`security.rate.limited`/`security.suspicious.activity`
- [ ] `/auth/signup-passkey/options` — pending
- [ ] `/auth/passkey/*` (6 routes) — pending
- [ ] `/auth/magic-link/send` — pending
- [ ] `/auth/mobile/refresh`, `/auth/device/register` — pending
- [x] `/auth/desktop/exchange` — `auth.token.created`
- [x] `/auth/mcp-tokens`, `/auth/mcp-tokens/[tokenId]` — `auth.token.created`/`auth.token.revoked`
- [x] `/auth/me` — `data.read`
- [x] `/auth/resend-verification`, `/auth/verify-email` — `auth.token.created`/`auth.email.verified`
- [x] `/auth/socket-token`, `/auth/ws-token` — `auth.token.created`
- `/auth/csrf`, `/auth/login-csrf` — skip (stateless, no user context)

**Acceptance criteria:**
- [x] OAuth success/failure correctly distinguished with graduated riskScores
- [x] Fire-and-forget via centralized `audit()` with `.catch()`
- [x] No functional behavior changes to any route
- [ ] All auth routes have appropriate audit calls (~17/31 done; passkey/* + magic-link/send + mobile/refresh + device/register still pending)
- [ ] `pnpm typecheck` passes
- [ ] No new `any` types

---

### PR 2: `audit/admin-routes` — Admin Domain (12 routes) [CRITICAL]

Admin operations are high-privilege — every action must be auditable.

**Routes:**
- `/admin/users` — `logDataAccess(read, 'admin_users')`
- `/admin/users/create` — `logDataAccess(write, 'user', newUserId)`
- `/admin/users/[userId]/data` — `logDataAccess(export, 'user', userId)`
- `/admin/users/[userId]/export` — `logDataAccess(export, 'user', userId)`
- `/admin/users/[userId]/gift-subscription` — `logDataAccess(write, 'subscription', userId)`
- `/admin/users/[userId]/subscription` — `logDataAccess(write, 'subscription', userId)`
- `/admin/audit-logs` — `logDataAccess(read, 'audit_logs')`
- `/admin/audit-logs/export` — `logDataAccess(export, 'audit_logs')`
- `/admin/audit-logs/integrity` — `logDataAccess(read, 'audit_integrity')`
- `/admin/global-prompt` — `logDataAccess(write, 'global_prompt')`
- `/admin/schema` — `logDataAccess(read, 'schema')`
- `/admin/contact` — skip (public form)

**Acceptance criteria:** Same as PR 1 pattern.

---

### PR 3: `audit/ai-chat-routes` — AI/Chat Domain (22 routes) [CRITICAL]

AI operations involve data access (reading pages for context), model interactions, and agent management.

**Routes:**
- `/ai/chat` — `logDataAccess(write, 'ai_chat')` (creates AI interactions)
- `/ai/chat/messages`, `/ai/chat/messages/[messageId]` — `logDataAccess(read/write/delete)`
- `/ai/chat/messages/[messageId]/undo` — `logDataAccess(write, 'ai_message', messageId, { action: 'undo' })`
- `/ai/abort` — `logDataAccess(write, 'ai_chat', null, { action: 'abort' })`
- `/ai/global/*` (5 routes) — `logDataAccess` per operation
- `/ai/page-agents/*` (8 routes) — `logDataAccess` per operation
- `/ai/settings` — `logDataAccess(read/write, 'ai_settings')`
- `/ai/ollama/models`, `/ai/lmstudio/models` — skip (local model discovery, no user data)

**Acceptance criteria:** Same as PR 1 pattern.

---

### PR 4: `audit/stripe-billing-routes` — Stripe/Billing (18 routes) [HIGH]

Financial operations — subscription changes, payment methods, billing.

**Routes:**
- `/stripe/create-subscription` — `logDataAccess(write, 'subscription')`
- `/stripe/cancel-subscription` — `logDataAccess(delete, 'subscription')`
- `/stripe/update-subscription` — `logDataAccess(write, 'subscription')`
- `/stripe/reactivate-subscription` — `logDataAccess(write, 'subscription')`
- `/stripe/cancel-schedule` — `logDataAccess(write, 'subscription_schedule')`
- `/stripe/payment-methods` — `logDataAccess(read/write, 'payment_method')`
- `/stripe/setup-intent` — `logDataAccess(write, 'payment_method')`
- `/stripe/customer` — `logDataAccess(read, 'billing_customer')`
- `/stripe/invoices` — `logDataAccess(read, 'invoices')`
- `/stripe/upcoming-invoice` — `logDataAccess(read, 'invoice')`
- `/stripe/billing-address` — `logDataAccess(read/write, 'billing_address')`
- `/stripe/portal` — `logDataAccess(read, 'billing_portal')`
- `/stripe/apply-promo`, `/stripe/validate-promo-code` — `logDataAccess(read, 'promo_code')`
- `/stripe/cancel-checkout` — `logDataAccess(write, 'checkout')`
- `/stripe/webhook` — skip (Stripe-initiated, no user session)
- `/subscriptions/status`, `/subscriptions/usage` — `logDataAccess(read)`

**Acceptance criteria:** Same as PR 1 pattern.

---

### PR 5: `audit/integrations-calendar-routes` — Integrations + Calendar (17 routes) [HIGH]

OAuth grant management, external service connections, calendar sync.

**Routes:**
- `/integrations/connections/[connectionId]/grants` — `logDataAccess(read/write, 'oauth_grant')`
- `/integrations/google-calendar/*` (8 routes) — `logDataAccess` + `logTokenCreated/Revoked` for connect/disconnect
- `/integrations/providers/*` (4 routes) — `logDataAccess(read/write, 'integration_provider')`
- `/integrations/providers/import-openapi` — `logDataAccess(write, 'openapi_import')`
- `/integrations/providers/install` — `logDataAccess(write, 'integration_install')`
- `/calendar/events`, `/calendar/events/[eventId]` — `logDataAccess` per operation
- `/calendar/events/[eventId]/attendees` — `logDataAccess(write, 'calendar_attendees')`
- `/integrations/google-calendar/webhook` — skip (Google-initiated)

**Acceptance criteria:** Same as PR 1 pattern.

---

### PR 6: `audit/comms-routes` — Messages + Channels + Notifications (14 routes) [MEDIUM]

Communication features — messaging, channels, notification management.

**Routes:**
- `/channels/[pageId]/messages` — `logDataAccess(read/write, 'channel_message')`
- `/channels/[pageId]/messages/[messageId]/reactions` — `logDataAccess(write, 'reaction')`
- `/channels/[pageId]/read` — skip (read receipt, low-risk)
- `/channels/[pageId]/upload` — `logDataAccess(write, 'channel_upload')`
- `/messages/*` (4 routes) — `logDataAccess` per operation
- `/notifications` — `logDataAccess(read/write, 'notification')`
- `/notifications/[id]` — `logDataAccess(read/delete, 'notification')`
- `/notifications/[id]/read` — skip (read receipt)
- `/notifications/push-tokens` — `logTokenCreated`
- `/notifications/read-all` — skip (bulk read receipt)
- `/notifications/unsubscribe/[token]` — `logDataAccess(write, 'notification_prefs')`
- `/inbox` — `logDataAccess(read, 'inbox')`

**Acceptance criteria:** Same as PR 1 pattern.

---

### PR 7: `audit/user-data-routes` — User + Files + Activities + Connections (21 routes) [MEDIUM]

User preferences, file operations, activity history, social connections.

**Routes:**
- `/user/assistant-config` — `logDataAccess(read/write, 'assistant_config')`
- `/user/favorites/*` (4 routes) — `logDataAccess` per operation
- `/user/integrations/*` (3 routes) — `logDataAccess` + `logTokenCreated/Revoked`
- `/user/recents` — `logDataAccess(read, 'recents')`
- `/files/[id]/convert-to-document` — `logDataAccess(write, 'file', id, { action: 'convert' })`
- `/files/[id]/download` — `logDataAccess(read, 'file', id, { action: 'download' })`
- `/files/[id]/view` — `logDataAccess(read, 'file', id)`
- `/activities/*` (6 routes) — `logDataAccess` per operation, rollbacks get `write`
- `/connections/*` (3 routes) — `logDataAccess` per operation
- `/agents/[agentId]/integrations/*` (2 routes) — `logDataAccess`

**Acceptance criteria:** Same as PR 1 pattern.

---

### PR 8: `audit/ops-routes` — Trash + Search + Workflows + Voice + MCP (15 routes) [MEDIUM]

Operational features — trash recovery, search, workflow execution, voice, MCP protocol.

**Routes:**
- `/trash/[pageId]` — `logDataAccess(delete/write, 'trash')` (delete = permanent, write = restore)
- `/trash/drives/[driveId]` — `logDataAccess(delete/write, 'trash_drive')`
- `/search`, `/search/multi-drive` — `logDataAccess(read, 'search')`
- `/workflows/*` (4 routes) — `logDataAccess` per operation
- `/voice/synthesize` — `logDataAccess(read, 'voice_synthesis')`
- `/voice/transcribe` — `logDataAccess(write, 'voice_transcription')`
- `/mcp/documents`, `/mcp/drives` — `logDataAccess(read)`
- `/mcp-ws` — `logDataAccess(read, 'mcp_websocket')`
- `/mentions/search` — `logDataAccess(read, 'mentions')`
- `/permissions/batch` — `logDataAccess(write, 'permissions')`

**Acceptance criteria:** Same as PR 1 pattern.

---

### PR 9: `audit/system-routes` — Cron + System + Misc (remaining ~20 routes) [LOW]

Background jobs and system endpoints. Many of these are internal/operational and may not need user-level audit.

**Routes to audit:**
- `/cron/*` (9 routes) — `logDataAccess(write, 'cron_job', null, { job: 'name' })` for data-mutating crons
- `/activities/export` — `logDataAccess(export, 'activities')`
- `/feedback` — `logDataAccess(write, 'feedback')`
- `/users/find`, `/users/search` — `logDataAccess(read, 'user_search')`
- `/storage/check`, `/storage/info` — `logDataAccess(read, 'storage')`
- `/tasks` — `logDataAccess(read, 'tasks')`
- `/track` — skip (analytics, no sensitive data)
- `/pulse/*` (3 routes) — skip (internal monitoring)
- `/provisioning-status/[slug]` — skip (status check)

**Routes to skip (no user context / public / read-only system):**
- `/health` — health check, no auth
- `/compiled-css` — static asset
- `/debug/chat-messages` — dev-only
- `/contact` — public form
- `/avatar/[userId]/[filename]` — public asset serving
- `/desktop-bridge/status` — desktop status check
- `/internal/*` (2 routes) — internal monitoring
- `/monitoring/[metric]` — metrics endpoint
- `/memory/cron` — internal cron

**Acceptance criteria:** Same as PR 1 pattern.

---

## Orchestration Strategy

**Worktree slots available**: 2 (3 of 5 in use)
**Approach**: Rolling spawn — as worktree agents finish and PRs merge, spawn the next batch.

| Wave | PRs | Agents | Prerequisite |
|------|-----|--------|--------------|
| 1 | PR 1 (auth) + PR 2 (admin) | 2 worktree agents | Now |
| 2 | PR 3 (ai/chat) + PR 4 (stripe) | 2 worktree agents | Wave 1 slots free |
| 3 | PR 5 (integrations) + PR 6 (comms) | 2 worktree agents | Wave 2 slots free |
| 4 | PR 7 (user/data) + PR 8 (ops) | 2 worktree agents | Wave 3 slots free |
| 5 | PR 9 (system) | 1 worktree agent | Wave 4 slot free |

## Verification

After all PRs merge:
- `pnpm typecheck` passes
- `pnpm test` passes
- Grep for routes without `securityAudit` — only skipped routes remain
- Run `pnpm dev` and verify no runtime errors
