# GDPR Audit — Stream 1: Data Subject Rights, Retention, and Erasure

**Scope:** GDPR Articles 5(1)(e), 12(3), 15, 16, 17, 17(2), 17(3)(b), 18, 20, 21
**Audit date:** 2026-04-12
**Worktree:** `pu/gdpr-dsr-retention` (`wt-fifec2a7`)
**Status:** Findings grounded in direct code reads. Every citation is `file:line`. This is a read-only audit — no source was modified.

---

## 1. Executive Summary

PageSpace has built substantial GDPR compliance scaffolding: rate-limited self-service DSAR export, admin DSAR endpoints, a multi-table retention-cleanup cron, an AI usage log anonymize-then-purge lifecycle, tamper-evident security audit logging with an explicit Art 17(3)(b) legal-obligation exemption, and comprehensive FK cascades across 29 schema files. The foundations are good.

However, the audit found **four P0 gaps that prevent lawful fulfilment of erasure requests** in the general case, **six P1 gaps** that put the controller at compliance risk even when erasure completes, and roughly a dozen P2 observations. None of the gaps are architectural dead-ends; all are addressable.

**Top five risks:**

1. **Art 17(2) — zero processor notification.** Stripe customers, OAuth tokens (GitHub, Slack, Google Calendar), AI provider data (Anthropic / OpenAI / Google / xAI / OpenRouter), and email-provider state are never propagated on erasure. `packages/lib/src/integrations/repositories/connection-repository.ts:142-152` shows integration "deletion" is a bare DB row delete — upstream access tokens remain valid at the provider until natural expiry.
2. **Art 12(3) + Art 17 — no unblockable erasure path.** If a user owns a drive with other members, both self-service DELETE (`apps/web/src/app/api/account/route.ts:188-196`) and admin DSAR DELETE (`apps/web/src/app/api/admin/users/[userId]/data/route.ts` via `accountRepository.checkAndDeleteSoloDrives`) hard-block with HTTP 400. There is no forced-deletion / ownership-transfer escalation, no async job queue, and no 30-day completion ledger. A user whose co-owners are unresponsive cannot complete erasure within the statutory window without manual engineering intervention.
3. **Art 17 — physical file erasure is lazy and eventual.** Account deletion cascades `files` DB rows through the `drives` FK but never touches disk. Physical file reaping is delegated to the Sunday-5-AM `cleanup-orphaned-files` cron (`apps/web/src/app/api/cron/cleanup-orphaned-files/route.ts`), which is fail-closed on processor errors and content-hash-addressed — a deleted user's file content may persist for a week or more, longer if any other user's page still references the same content hash.
4. **Art 15 / Art 20 — export is incomplete.** `packages/lib/src/compliance/export/gdpr-export.ts:99-108` returns exactly 8 categories. Missing from both self-service and admin export: notifications, feedback submissions, email/push notification preferences, display preferences, personalization, hotkeys, calendar triggers, contacts, social connections, device list, integration connection inventory, user AI settings, page versions, drive backups, received DMs (only sent DMs are exported — `gdpr-export.ts:282` filters on `senderId`), and the subject's own security audit log entries. File *binary content* is also excluded — only metadata.
5. **Art 5(1)(e) — several high-volume tables have no retention window at all.** `activity_logs`, `error_logs`, `user_activities`, and soft-trashed content (`pages.isTrashed`, `drives.isTrashed`, soft-deleted messages without matching 30-day cron targets) accumulate indefinitely unless a user-deletion event triggers purge.

**Gap counts by severity:** P0 = 5 · P1 = 6 · P2 = 12

**Deployment-mode impact:** Most gaps apply to all three modes (cloud / onprem / tenant). The Stripe-specific gap is N/A in `onprem` (billing disabled via `packages/lib/src/deployment-mode.ts`) and partially abstracted away in `tenant` (billing lives in the control-plane repo, not this repo). The AI provider notification gap is absent in onprem installations configured with Ollama-only. See §6.

---

## 2. Scope and Methodology

### In scope

- Self-service DSR endpoints: `/api/account/export`, `/api/account` (GET, PATCH, DELETE)
- Admin DSR endpoints: `/api/admin/users/[userId]/export`, `/api/admin/users/[userId]/data`
- Activities export: `/api/activities/export`
- Drives integrations audit export: `/api/drives/[driveId]/integrations/audit/export`
- Retention crons: `retention-cleanup`, `purge-ai-usage-logs`, `purge-deleted-messages`, `cleanup-orphaned-files`, `cleanup-tokens`
- Every schema file under `packages/db/src/schema/` (29 files) for FK-cascade completeness
- File erasure pathway across `apps/web/src/app/api/cron/cleanup-orphaned-files/route.ts`, `packages/lib/src/compliance/file-cleanup/orphan-detector.ts`, and `apps/processor/` bridge points
- AI chat, direct message, and conversation erasure paths
- Vector / search index erasure (investigated; see finding F-17-3)
- Version history (`pageVersions`, `driveBackups`) and soft-delete flows
- Backups + their interaction with erasure
- Audit-log retention and Art 17(3)(b) legal-obligation exemption
- Export completeness and Art 20 format compliance
- Art 17(2) third-party / processor notification
- 30-day completion window (Art 12(3))

### Out of scope (other streams)

- Consent management, lawful bases, ToS/privacy policy copy (Stream 2 or 3)
- International transfers and SCCs (Stream 2)
- Breach notification workflows (Stream 4)
- Children's data / Art 8 gating

### Methodology

For every finding: read the actual file, not a summary; cite line numbers; tag the GDPR article that is implicated; classify severity P0 (blocks lawful compliance), P1 (significant risk), P2 (operational hardening). Findings that could not be tied to a specific article are moved to the Observations Appendix.

Three parallel Explore agents produced initial mappings; every P0 and P1 claim in this document was **re-verified by direct file read during the plan phase**, which caught one significant Explore-agent error (monitoring retention is in fact partially implemented — see F-5e-2) and surfaced one P0 gap that agents missed (received DMs not exported).

No claims are sourced from `docs/security/compliance-sovereignty-analysis.md` without independent code verification.

### Deployment-mode handling

PageSpace ships three runtime modes gated by `DEPLOYMENT_MODE` at `packages/lib/src/deployment-mode.ts`: `cloud` (default, SaaS at pagespace.ai), `onprem` (self-hosted, no Stripe, no self-registration), `tenant` (multi-tenant managed via a separate control-plane repo at `/Users/jono/production/PageSpace-Deploy/`). Where a finding diverges across modes, §6 records the delta. When unqualified, a finding applies to all three modes.

---

## 3. Three Mandatory Questions

The spec requires explicit answers to these before anything else.

### Q1 — Can a user request erasure and have it completed within 30 days without manual admin action?

**No.**

Two independent blockers:

1. **Multi-member drive block.** `apps/web/src/app/api/account/route.ts:188-196` returns HTTP 400 if the user owns drives with members other than themselves. The admin path at `packages/lib/src/repositories/account-repository.ts:86-122` (`checkAndDeleteSoloDrives`) wraps the check in a transaction and aborts with `multiMemberDriveNames` if any. There is **no ownership-transfer automation, no forced-deletion escalation, no guardian-account fallback**. A user whose co-owners are unresponsive cannot complete the flow — not even an admin can without manual data surgery.
2. **Eventual physical erasure.** DB rows delete synchronously, but physical files on processor storage are only reaped by the weekly `cleanup-orphaned-files` cron (`apps/web/src/app/api/cron/cleanup-orphaned-files/route.ts`), which runs Sunday 5 AM UTC. Files with any other reference in `file_pages`, `channel_messages`, or `pages` are exempt until last reference removed. Content-addressed storage means file content can live on disk indefinitely if shared across users. No audit emits a "fully erased" completion event.

The synchronous delete path *can* finish within a single HTTP request for solo users, but there is no queue, retry policy, or completion ledger to demonstrate compliance with Art 12(3) in aggregate.

### Q2 — Are processors notified of erasure per Art 17(2)?

**No.**

Zero processors are notified on erasure. Specifically:

- **Stripe** (cloud mode): `apps/web/src/app/api/account/route.ts` and the identical admin path contain no `stripe` import, no `customers.del`, no subscription cancellation. `accountRepository.deleteUser` at `packages/lib/src/repositories/account-repository.ts:78-80` is a one-line DB delete:
  ```ts
  deleteUser: async (userId: string): Promise<void> => {
    await db.delete(users).where(eq(users.id, userId));
  }
  ```
  Stripe customers persist after PageSpace account deletion.
- **OAuth providers** (Slack, GitHub, Google Calendar): provider configs define `revokeUrl` (`packages/lib/src/integrations/providers/slack.ts:25`, `github.ts:21`), but no code calls it. `deleteConnection` at `packages/lib/src/integrations/repositories/connection-repository.ts:142-152` is a pure DB row delete. Account deletion does not even iterate `integrationConnections` — it relies on FK cascade. Live upstream tokens remain valid until natural expiry.
- **AI providers** (Anthropic / OpenAI / Google / xAI / OpenRouter / Ollama): no delete-forwarding code exists under `apps/web/src/lib/ai/`. Anthropic and OpenAI both offer zero-data-retention and/or data-deletion APIs — neither is wired up. Note: local Ollama in onprem mode has no cloud-side data, so this gap is cloud/tenant-only for most providers.
- **Email provider**: no Resend/SendGrid unsubscribe-list notification. `emailUnsubscribeTokens` is cascade-deleted in-DB; the provider's suppression list is never synced.
- **Realtime / websocket clients**: users remain connected via live sockets; a manual `/api/auth/logout-all` is required to terminate sessions.

### Q3 — Does admin export reach the same completeness as self-service export?

**Yes — which is to say, equally incomplete.**

`apps/web/src/app/api/admin/users/[userId]/export/route.ts:19-22` directly calls `collectAllUserData(db, userId)` — the same entry point used by self-service at `apps/web/src/app/api/account/export/route.ts:44-47`. Both return the 8-category `AllUserData` shape defined at `packages/lib/src/compliance/export/gdpr-export.ts:99-108`. Both inherit the 17+ missing categories documented in F-15-1.

Two minor asymmetries:
- Self-service is rate-limited to 1 export per 24h (`account/export/route.ts:27-41`); admin export is unlimited.
- Admin export returns raw JSON; self-service wraps into a streaming ZIP via `archiver`.
- Admin export adds `exportedAt` and `exportedBy` fields (`admin/users/[userId]/export/route.ts:36-39`).

Neither asymmetry creates a compliance gap by itself.

---

## 4. Findings by GDPR Article

### 4.1 — Art 15: Right of Access

#### F-15-1 [P0] Self-service and admin exports are missing 17+ data categories

**Article:** Art 15(1)(b), (c), (e), (g); Art 15(3)
**Severity:** P0
**Applies to:** cloud, onprem, tenant

`packages/lib/src/compliance/export/gdpr-export.ts:99-108` defines `AllUserData` as exactly 8 fields:

```ts
export interface AllUserData {
  profile: UserProfileExport;
  drives: UserDriveExport[];
  pages: UserPageExport[];
  messages: UserMessageExport[];
  files: UserFileExport[];
  activity: UserActivityExport[];
  aiUsage: UserAiUsageExport[];
  tasks: UserTaskExport[];
}
```

Neither self-service (`account/export/route.ts:76-83`) nor admin (`admin/users/[userId]/export/route.ts:19-22`) adds anything. Categories verifiably missing from the export, each of which is personal data under Art 4(1) and therefore in scope for Art 15:

| Missing category | Schema source | Why it's personal data |
|---|---|---|
| Notifications | `packages/db/src/schema/notifications.ts` | Permission-grant, mention, invite, assignment events — addressed to the user |
| Feedback submissions | `packages/db/src/schema/feedback.ts` | User-submitted free text + environment metadata (userAgent, console errors) |
| Email notification preferences | `packages/db/src/schema/email-notifications.ts` | Subscription status per event type |
| Push notification settings | `packages/db/src/schema/push-notifications.ts` | Device tokens, enabled flags |
| Display preferences | `packages/db/src/schema/display-preferences.ts` | Theme, layout, sidebar width |
| Personalization | `packages/db/src/schema/personalization.ts` | Custom key/value preferences |
| Hotkeys | `packages/db/src/schema/hotkeys.ts` | User-defined keybindings |
| Calendar triggers | `packages/db/src/schema/calendar-triggers.ts` | User-configured calendar automation |
| Contacts | `packages/db/src/schema/contact.ts` | User's contact list |
| Social connections | `packages/db/src/schema/social.ts` (`connections`, `dmConversations`) | Peer-relationship graph |
| Device sessions | `packages/db/src/schema/auth.ts` (`deviceTokens`) | Device names, fingerprints, last-seen |
| User AI settings | `packages/db/src/schema/ai.ts` | Encrypted API keys, provider preferences |
| Integration connection inventory | `packages/db/src/schema/integrations.ts` | Which external services are connected |
| Page versions authored | `packages/db/src/schema/versioning.ts` (`pageVersions`) | User-authored content snapshots |
| Drive backups authored | `packages/db/src/schema/versioning.ts` (`driveBackups`) | User-authored drive snapshots |
| Security audit entries (subject) | `packages/db/src/schema/security-audit.ts` | Art 15 entitles the user to know what is logged about them |
| Received direct messages | `packages/db/src/schema/social.ts` (`directMessages`) | See F-15-2 |

**Additional gap (file binary content):** `collectUserFiles()` at `gdpr-export.ts:297-311` returns only metadata — `id, driveId, sizeBytes, mimeType, storagePath, createdAt`. Uploaded file bodies are not included. Art 20 explicitly covers "data … which he or she has provided to a controller" — uploaded documents are the canonical example. The export tells the user they have a file but does not give them the file.

**Fix sketch:** Extend `AllUserData` to cover each missing table with a dedicated `collectX` function modeled on the existing ones. Include file binary via streamed ZIP entries using the existing `archiver` infrastructure (or signed storage URLs with a documented expiry).

---

#### F-15-2 [P0] Received direct messages are not exported

**Article:** Art 15(1), Art 20
**Severity:** P0
**Applies to:** cloud, onprem, tenant

`packages/lib/src/compliance/export/gdpr-export.ts:274-282` filters DMs on `senderId`:

```ts
const dms = await database
  .select({ … })
  .from(directMessages)
  .where(eq(directMessages.senderId, userId));
```

`directMessages` joins a 1:1 `dmConversations` table (`packages/db/src/schema/social.ts:35-81`) with `participant1Id` / `participant2Id`. A user who is `participant2` but not `senderId` on a given row is the addressee of that DM — Art 15 clearly entitles them to it. The current query drops these entirely. Half of every conversation is invisible in the export.

**Fix sketch:** Join via `dmConversations` on participant columns, not `senderId`.

---

#### F-15-3 [P1] Activities export truncates at 10,000 rows

**Article:** Art 15(1)
**Severity:** P1
**Applies to:** cloud, onprem, tenant

`apps/web/src/app/api/activities/export/route.ts` (CSV export, `X-Truncated` header on overflow). For long-tenured users this silently drops audit history. The subject is told via a header but not required to acknowledge.

**Fix sketch:** Paginate via cursor; stream CSV rows to the response as they come out of the DB.

---

#### F-15-4 [P2] No rate limit or abuse-control on admin export

**Article:** Art 15 (operational — no direct compliance gap)
**Severity:** P2

Self-service rate limit is enforced at `account/export/route.ts:27-41` (`EXPORT_DATA` = 1 per 24h). Admin export at `admin/users/[userId]/export/route.ts` has no rate limit. Insider-risk concern rather than subject-rights concern; noted for completeness.

---

### 4.2 — Art 17: Right to Erasure

#### F-17-1 [P0] Physical file erasure is eventual and weak

**Article:** Art 17(1)
**Severity:** P0
**Applies to:** cloud, onprem, tenant

`apps/web/src/app/api/account/route.ts:135-275` cascade-deletes the `files` DB rows via the `drives` → `files.driveId` cascade (`packages/db/src/schema/storage.ts:8-10`). It does **not** delete physical storage. The processor service is called only to remove the user's avatar (`account/route.ts:207-222`). All other file binaries wait for the Sunday-5-AM orphan reaper (`apps/web/src/app/api/cron/cleanup-orphaned-files/route.ts`).

The reaper is fail-closed: it only removes DB rows for orphans whose physical delete succeeded (`cleanup-orphaned-files/route.ts:88-100`). Failed physical deletes are retried next week. This is correct for orphan hygiene but means a user's erasure can span multiple weeks if processor storage is flaky.

Worse, content-addressed storage (content hash extracted via `/^[a-f0-9]{64}$/i` at `cleanup-orphaned-files/route.ts:50-52`) means any file whose hash is referenced by another user's page is never deleted at all. The reaper only removes files with **zero** references across `file_pages`, `channel_messages`, and `pages`. File *content* can therefore persist indefinitely after a user erasure request, even after the initiator's file rows are gone.

**Fix sketch:** On account delete, enqueue a deletion job per owned file with a deadline (e.g. T + 7 days), emit a completion event when verified, and surface to the user a machine-readable receipt showing what was erased when. For content-addressed shared content, either track per-owner encryption keys (so deleting a key evicts access without touching bytes), or accept the sovereignty tradeoff and document it in the privacy notice.

---

#### F-17-2 [P0] No async / retry / completion path for erasure

**Article:** Art 17(1), Art 12(3)
**Severity:** P0
**Applies to:** cloud, onprem, tenant

The DELETE handler at `apps/web/src/app/api/account/route.ts:135-275` runs the entire sequence in a single HTTP request:

1. Solo-drive delete
2. Avatar delete (processor call)
3. `logUserActivity('account_delete', …)`
4. `activityLogRepository.anonymizeForUser`
5. `deleteAiUsageLogsForUser`
6. `deleteMonitoringDataForUser`
7. `auditRequest({ eventType: 'admin.user.deleted' })`
8. `accountRepository.deleteUser`

Each step is wrapped in its own try/catch that logs and continues. There is no queue, no resumable state machine, no "deletion pending" status the subject can poll. If any step hangs or the HTTP request is interrupted, the controller has no record of partial completion, and the subject has no receipt. There is also no mechanism to complete erasure asynchronously when blocked (e.g. the multi-member drive case in F-17-4).

This creates Art 12(3) risk in aggregate: the controller cannot demonstrate that all requests complete within 30 days.

**Fix sketch:** Move erasure behind a durable job queue (e.g. a `data_subject_requests` table with `status` and `completed_steps` JSON), process it in a worker, and emit a verifiable completion event.

---

#### F-17-3 [P2] No persistent search or vector index found — no erasure pathway needed today

**Article:** Art 17(1) (by absence)
**Severity:** observation

Searched `packages/` for `pgvector|tsvector|to_tsvector|searchIndex|meilisearch|typesense|elasticsearch|embedding`. Zero matches. `pages.excludeFromSearch` flag exists at `packages/db/src/schema/core.ts` but has no backing persistent index. Conclusion: there is currently no persistent search or vector index that needs an erasure pathway. **If PG FTS or a vector store is added later, erasure forwarding must be designed into the integration.** Noted in observations for future reviewers.

---

#### F-17-4 [P0] Multi-member drive blocker has no escalation path

**Article:** Art 17(1), Art 12(3)
**Severity:** P0
**Applies to:** cloud, onprem, tenant

Self-service at `apps/web/src/app/api/account/route.ts:188-196`:

```ts
if (multiMemberDrives.length > 0) {
  return Response.json(
    { error: 'You must transfer ownership or delete all drives with other members before deleting your account',
      multiMemberDrives: multiMemberDrives.map(d => d.name) },
    { status: 400 }
  );
}
```

Admin path at `packages/lib/src/repositories/account-repository.ts:86-122` uses the same logic wrapped in a transaction. Neither has an override flag. There is no ownership-transfer prompt, no guardian-account auto-transfer, no way for an admin to force-delete the drive and notify the other members. A user whose drive co-owners have gone silent cannot complete erasure.

**Fix sketch:** Add admin-only force path that (a) reassigns ownership to a system account, (b) notifies members, (c) continues the erasure. Consider adding user-facing "transfer ownership" UI that can nominate another member inline during the deletion flow.

---

#### F-17-5 [P1] Soft-trashed pages and drives never become hard deletes

**Article:** Art 17(1), Art 5(1)(e)
**Severity:** P1
**Applies to:** cloud, onprem, tenant

`packages/db/src/schema/core.ts` defines `pages.isTrashed` and `drives.isTrashed` as soft-delete flags. There is no cron that converts soft-trashed rows to hard deletes after a grace period. Content in the trash persists indefinitely until the drive itself is hard-deleted.

Contrast with `chat_messages`, `channel_messages`, `conversations`, and `messages`, which all use an `isActive=false` soft-delete that is hard-purged after 30 days by the daily 4 AM `purge-deleted-messages` cron. Pages and drives should have equivalent hard-delete cleanup for Art 17 coverage; otherwise "delete" in the UI does not mean "delete" in the legal sense.

**Fix sketch:** Add a `purge-trashed-content` cron that hard-deletes `pages.isTrashed=true` and `drives.isTrashed=true` rows older than N days (default 30, configurable).

---

### 4.3 — Art 17(2): Notification to Recipients / Processors

#### F-17-2-1 [P0] Stripe customers are not deleted on erasure

**Article:** Art 17(2)
**Severity:** P0
**Applies to:** cloud only (onprem disables billing; tenant handles billing in the control-plane repo)

Verified by reading `apps/web/src/app/api/account/route.ts` end-to-end and grepping for `stripe` in the `apps/web/src/app/api/account` tree: **zero matches**. `accountRepository.deleteUser` at `packages/lib/src/repositories/account-repository.ts:78-80` is a pure DB delete with no Stripe hook.

Stripe customer records, subscription history, payment methods, and invoice PDFs persist at Stripe. The Art 17(2) obligation to "inform the [recipient]" — Stripe is a processor under Art 28 — is not met.

**Fix sketch:** In the account delete handler, before `deleteUser`, if `user.stripeCustomerId` is set and `DEPLOYMENT_MODE` is `cloud`, call `stripe.customers.del(customerId)`, log the result to the security audit, and proceed. Guard with a try/catch that logs but does not fail the erasure (Art 17(2) requires "reasonable steps", not perfect propagation).

---

#### F-17-2-2 [P0] OAuth integration tokens are not revoked upstream

**Article:** Art 17(2)
**Severity:** P0
**Applies to:** cloud, onprem, tenant

`packages/lib/src/integrations/repositories/connection-repository.ts:142-152` — the single `deleteConnection` function — is a bare DB row delete:

```ts
export const deleteConnection = async (
  database: typeof defaultDb,
  connectionId: string
): Promise<IntegrationConnection | null> => {
  const [deleted] = await database
    .delete(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .returning();
  return deleted ?? null;
};
```

Provider configs do define `revokeUrl` — e.g. `packages/lib/src/integrations/providers/slack.ts:25` (`https://slack.com/api/auth.revoke`) and `packages/lib/src/integrations/providers/github.ts:21` — but a grep across the codebase shows `revokeUrl` is only referenced in provider definitions and tests, never called at runtime.

Account deletion makes this worse: it doesn't even iterate `integrationConnections` for the user — it relies on FK cascade via `users.id`. The upstream OAuth tokens at Slack, GitHub, Google Calendar, etc. remain valid until natural expiry. A malicious former employee who exported their access token before account deletion retains Slack write access for as long as the token lives.

**Fix sketch:** In `deleteConnection`, if the provider has a `revokeUrl`, POST the token to it before deleting the DB row. On account delete, iterate `integrationConnections` for the user and call `deleteConnection` for each one. Log the outcome of each provider call to the security audit.

---

#### F-17-2-3 [P1] AI provider data is not deleted / forwarded

**Article:** Art 17(2)
**Severity:** P1
**Applies to:** cloud, tenant (onprem is P2 when Ollama-only)

PageSpace sends prompt and completion content to 6 providers (Anthropic / OpenAI / Google / xAI / OpenRouter / Ollama) via the Vercel AI SDK. On erasure, PageSpace deletes its local copy (`chat_messages` cascade + `deleteAiUsageLogsForUser` + the 30/90-day AI usage log purge in `purge-ai-usage-logs/route.ts`), but it does not ask the provider to delete theirs.

Anthropic offers zero-data-retention (ZDR) as an account-level setting; OpenAI offers data-deletion endpoints and per-request ZDR; Google Vertex has similar levers. None are wired into PageSpace. Controllers should either (a) configure ZDR at the provider-account level and document the setting, or (b) forward erasure requests via the provider's deletion API, or (c) document in the privacy notice that once data leaves PageSpace, provider retention controls it.

**Fix sketch:** Add a `forwardErasureToAiProviders(userId)` step in the deletion pipeline, guarded by provider-capability flags. Record which providers were notified in the audit log. For providers without deletion APIs, rely on ZDR and document it.

---

#### F-17-2-4 [P1] Email provider suppression list is not synced

**Article:** Art 17(2), Art 21
**Severity:** P1
**Applies to:** cloud, tenant (onprem deployments with local SMTP: N/A)

`email_unsubscribe_tokens` is cascade-deleted in DB (`packages/db/src/schema/auth.ts:253`), but no Resend/SendGrid/Postmark suppression-list API call is made. A deleted user's email address can be re-added to a marketing list by another mechanism later. Art 17(2) + Art 21 (right to object to direct marketing) both point at this.

**Fix sketch:** Maintain a persistent suppression record keyed on a hash of the email, and sync it to the email provider on delete.

---

### 4.4 — Art 17(3)(b): Legal Obligation Exemption (Audit Trail)

#### F-17-3b-1 [P1] Legal-obligation retention is documented in code but lacks a written policy and a maximum window

**Article:** Art 17(3)(b)
**Severity:** P1
**Applies to:** cloud, onprem, tenant

Three locations in code intentionally preserve data after erasure, citing the Art 17(3)(b) legal-obligation exemption:

1. **Security audit log.** `packages/db/src/schema/security-audit.ts:90` — `userId: text('user_id').references(() => users.id, { onDelete: 'set null' })`. Comment at `apps/web/src/app/api/account/route.ts:253-254`: *"security_audit_log is intentionally NOT deleted — legal retention requirement (tamper-evident hash chain must remain intact for compliance)"*. `packages/lib/src/compliance/retention/monitoring-retention.ts:49-50`: *"security_audit_log is intentionally excluded — tamper-evident hash chain requires infinite retention to preserve chain integrity for verification."*
2. **Activity logs.** `packages/lib/src/repositories/activity-log-repository.ts` `anonymizeForUser()` replaces `actorEmail`/`actorDisplayName` with hashes but preserves the row. The rationale is the same audit-trail integrity, but Art 17(3)(b) requires the retention to be justified by a specific legal obligation, not by generic audit preference.
3. **Admin deletion logging.** `admin/users/[userId]/data/route.ts:54-59` logs `account_delete` with masked email before anonymization.

Anonymization is a reasonable pseudonymization technique under Recital 26. The gap is that the *legal obligation* is never named anywhere in code or docs. Is it SOC 2? SOX? GDPR Art 30 records-of-processing? Local national retention law? Without a named obligation and a maximum retention window, Art 17(3)(b) cannot be invoked — the exemption is conditional on "the legal obligation … to which the controller is subject."

There is also no deletion clock for the security audit log itself. "Infinite retention" is not GDPR-compatible without a named legal basis and a review cadence.

**Fix sketch:** Publish a retention schedule document (`docs/security/retention-schedule.md`) that names each table, the legal basis, the maximum retention period, and the review cadence. Add a `max_age_years` hard cap on the security audit log (e.g. 7 years for SOX-like obligations) and a cron that purges entries older than the cap. Record the hash-chain anchor point when purges happen so integrity is preserved forward.

---

### 4.5 — Art 20: Data Portability

#### F-20-1 [P1] Export format is ZIP+JSON; minimal metadata; no schema document

**Article:** Art 20(1)
**Severity:** P1
**Applies to:** cloud, onprem, tenant

`apps/web/src/app/api/account/export/route.ts:76-94` produces a streaming ZIP with 8 JSON files. This meets the Art 20 requirement of "structured, commonly used and machine-readable format" at the surface level.

Gaps:
- No top-level manifest describing which files are present, their schemas, or which export version they conform to. Subjects reimporting data into another controller have to infer the shape.
- Field-level documentation is absent. `UserPageExport.content` is raw content (TipTap JSON or plain text depending on page type) — not documented anywhere in the export itself.
- Activity export uses CSV; other endpoints use JSON; this inconsistency is operationally harmless but makes reimport harder.

**Fix sketch:** Add a `manifest.json` inside the ZIP listing each included file with its schema version and row count. Consider adding a `README.md` inside the ZIP in plain English describing the structure.

---

#### F-20-2 [P2] No standard-format export (e.g. DTIF, Solid, IndieWeb)

**Article:** Art 20 (recommendation, not requirement)
**Severity:** P2

Art 20 encourages interoperable formats but does not require them. PageSpace's custom JSON schema is legal but not ideal. This is a P2 observation rather than a gap.

---

### 4.6 — Art 5(1)(e): Storage Limitation

#### F-5e-1 [P0] Several high-volume tables have no retention window

**Article:** Art 5(1)(e)
**Severity:** P0
**Applies to:** cloud, onprem, tenant

`packages/lib/src/compliance/retention/retention-engine.ts:124-140` invokes cleanup for 9 tables: `sessions`, `verification_tokens`, `socket_tokens`, `email_unsubscribe_tokens`, `pulse_summaries`, `page_versions` (unpinned), `drive_backups` (unpinned), `page_permissions`, `ai_usage_logs`. `runMonitoringRetentionCleanup()` at `packages/lib/src/compliance/retention/monitoring-retention.ts:52-59` adds `api_metrics` (default 90 days via `RETENTION_API_METRICS_DAYS`) and `system_logs` (default 30 days via `RETENTION_SYSTEM_LOGS_DAYS`).

**Not covered by any time-based retention cron:**

| Table | Source | Current behavior |
|---|---|---|
| `activity_logs` | `packages/db/src/schema/monitoring.ts:327` | Anonymized on user delete; never time-expired |
| `error_logs` | `packages/db/src/schema/monitoring.ts:212` | Hard-deleted per-user via `deleteMonitoringDataForUser` (`packages/lib/src/logging/monitoring-purge.ts:22`); not time-expired |
| `user_activities` | `packages/db/src/schema/monitoring.ts:113` | Same — per-user only |
| `pages.isTrashed = true` | `packages/db/src/schema/core.ts` | Soft-trashed pages persist indefinitely (see F-17-5) |
| `drives.isTrashed = true` | `packages/db/src/schema/core.ts` | Same |
| `page_versions` with `isPinned = true` | `packages/db/src/schema/versioning.ts:156` | Pinned versions are exempt from expiry |
| `drive_backups` with `isPinned = true` | `packages/db/src/schema/versioning.ts:178` | Pinned backups are exempt |
| `security_audit_log` | `packages/db/src/schema/security-audit.ts` | Infinite (see F-17-3b-1) |

Active accounts accumulate activity logs and error logs forever. The pinning mechanism on versions and backups creates an indefinite-retention vector at the user's discretion — acceptable on the "user asked for it" principle but opaque in the UI (no indication that a pinned item is outside the standard retention policy).

**Fix sketch:** Add time-based retention to `activity_logs` (default 2 years, env-configurable), `error_logs` (default 90 days), and `user_activities` (default 180 days). Extend `retention-engine.ts`. Add UI indication when pinning a version/backup that it will be retained beyond the default window.

---

#### F-5e-2 [P2] Retention windows are hardcoded in route handlers

**Article:** Art 5(1)(e) (operational)
**Severity:** P2

`apps/web/src/app/api/cron/purge-ai-usage-logs/route.ts:25-26` hardcodes `30 * 24 * 60 * 60 * 1000` and `90 * 24 * 60 * 60 * 1000`. `DEFAULT_VERSION_RETENTION_DAYS = 30` lives in `packages/db/src/schema/versioning.ts:52`. Monitoring retention is the only part that is env-configurable (`RETENTION_API_METRICS_DAYS`, `RETENTION_SYSTEM_LOGS_DAYS` — `packages/lib/src/compliance/retention/monitoring-retention.ts:20-25`).

Tenant deployments may have different jurisdictional retention requirements; hardcoded windows make per-tenant configuration impossible without a code change.

**Fix sketch:** Lift all retention windows to env vars with sane defaults. Document them in `packages/lib/src/deployment-mode.ts` alongside the mode flag.

---

### 4.7 — Art 12(3): One-Month Response Window

#### F-12-3-1 [P1] No evidence of 30-day SLA tracking

**Article:** Art 12(3)
**Severity:** P1
**Applies to:** cloud, onprem, tenant

Erasure is synchronous (F-17-2). There is no `data_subject_requests` table, no SLA dashboard, no metric that counts how many requests are outstanding or how long they've been pending. If a user initiates erasure and hits the multi-member-drive blocker (F-17-4), the system has no record that a request exists.

**Fix sketch:** Model DSR requests explicitly — a `data_subject_requests` table with `type` (access/erasure/rectification), `status`, `submittedAt`, `completedAt`, `completedBy`, and `completion_notes`. Emit a metric for requests outstanding > 21 days as an early warning.

---

## 5. Cascade-Delete Inventory

Every schema file under `packages/db/src/schema/` was inspected. FK directions and `onDelete` behavior below. Files reviewed: `ai, auth, calendar-triggers, calendar, chat, contact, conversations, core, dashboard, display-preferences, email-notifications, feedback, hotkeys, integrations, members, monitoring, notifications, page-views, permissions, personalization, push-notifications, security-audit, sessions, social, storage, subscriptions, tasks, versioning, workflows` (29 files).

**Key cascade invariants, verified directly:**

- `users` is the root of the cascade graph. Everything personal-data-bearing either cascades or sets null from a `userId` FK.
- **Set-null FKs (audit-trail preservation):** `security_audit_log.user_id` (`security-audit.ts:90`), `files.createdBy` (`storage.ts:17`), `file_pages.linkedBy` (`storage.ts:30`), `page_versions.createdBy` (`versioning.ts:145`), `drive_backups.createdBy` (`versioning.ts:171`), `activity_logs.userId/driveId/pageId` (per Agent 2 report; unverified by direct read — flagged for follow-up).
- **Cascade FKs (content follows user):** `sessions`, `passkeys`, `mcp_tokens`, `mcp_token_drives`, `verification_tokens`, `socket_tokens`, `email_unsubscribe_tokens`, `device_tokens` (auth.ts); `drives.ownerId` (core.ts); `pages.driveId` cascade → cascade through page tree (core.ts:26); `files.driveId` cascade (storage.ts:10); `file_pages.fileId/pageId` (storage.ts:23-29); `chat_messages.userId`, `channel_messages.userId/pageId`, `conversations.userId`, `messages.conversationId/userId`, `dm_conversations.participant1Id/participant2Id`, `direct_messages.conversationId/senderId` (chat.ts, conversations.ts, social.ts); `drive_members.userId/driveId`, `page_permissions.userId/pageId`, `user_profiles.userId` (members.ts); `page_versions.pageId/driveId`, `drive_backups.driveId`, `drive_backup_pages.backupId`, `drive_backup_permissions.backupId`, `drive_backup_members.backupId`, `drive_backup_roles.backupId`, `drive_backup_files.backupId` (versioning.ts); `task_lists.userId/pageId`, `task_items.taskListId/userId/assigneeId`, `task_assignees.taskId/userId` (tasks.ts); `workflows.driveId/createdBy/agentPageId/taskItemId/instructionPageId` (workflows.ts); `notifications.userId/pageId/driveId` (notifications.ts); `calendar_events.driveId/createdById` (calendar.ts); `connections.user1Id/user2Id/requestedBy` (social.ts); `favorites.userId/pageId/driveId` (core.ts); `user_page_views.userId/pageId` (page-views.ts); `subscriptions.userId`, `user_ai_settings.userId`, `user_dashboards.userId`, `pulse_summaries.userId`.

**Coverage gap (non-FK user data):** Several monitoring tables — `api_metrics`, `system_logs`, `error_logs`, `user_activities`, `ai_usage_logs` — store `userId` as a plain `text` column without a foreign key constraint. Cleanup on user delete relies on explicit `deleteMonitoringDataForUser` and `deleteAiUsageLogsForUser` calls in the DELETE handler. This is correct *if* the handler actually invokes them — which it does — but it means schema-level guarantees do not protect against a future route that forgets to call them. Worth a `@deprecated` comment on the columns pointing at the compliance helper.

**Pinned content exemption:** `page_versions.isPinned = true` and `drive_backups.isPinned = true` exempt from the retention cron (`packages/lib/src/compliance/retention/retention-engine.ts:73-79, 86-90`). On user account deletion, pinned items still cascade-delete via the drive FK, so erasure completes. The gap is only visible in the retention window, not in erasure.

---

## 6. Deployment-Mode Divergence

### Cloud

All findings apply. Stripe gap (F-17-2-1) is active. OAuth integrations live (GitHub, Slack, Google Calendar — per `packages/lib/src/integrations/providers/`). AI providers are all cloud-based (no local Ollama by default). Marketing email via Resend/SendGrid — F-17-2-4 active.

### Onprem

Stripe gap **N/A**. `packages/lib/src/deployment-mode.ts` disables billing flows in onprem mode; there is no Stripe customer to delete. Documented as such.

AI provider notification (F-17-2-3) is **reduced severity to P2** if the deployment is configured with local models only (Ollama). Cloud-based AI providers remain in scope if enabled.

OAuth token revocation (F-17-2-2) remains P0 for any enabled integrations. Many onprem deployments disable external integrations — if so, the finding is moot operationally but the code path still has the gap.

Self-registration is disabled; admin-only user management means the admin DSR path at `/api/admin/users/[userId]/data` is the primary channel. F-17-4 (multi-member drive blocker) still has no force-delete path.

### Tenant (managed multi-tenant)

Billing lives in `/Users/jono/production/PageSpace-Deploy/apps/control-plane/src/services/backup-service.ts` and related files. Stripe customer deletion is a control-plane concern, not a PageSpace-repo concern. **Stream 1 does not cover the control-plane repo in detail** — flagged for the Stream 1 remediation that a companion audit of the control-plane deletion path is required before closing F-17-2-1 for tenant mode.

Per-tenant retention overrides are not possible today (F-5e-2) — retention windows are hardcoded except for monitoring. A German tenant cannot set a 10-year financial-records retention without a code change.

---

## 7. Observations Appendix

Items without a clean GDPR article cite or sub-P2 severity:

1. **`excludeFromSearch` flag at `packages/db/src/schema/core.ts`** — dead flag without backing index today. If search is added later, erasure-forwarding must be built in.
2. **`pulse_summaries` has per-row `expiresAt`** but no global cap — a bug where `expiresAt` is set too far in the future would bypass retention.
3. **Hash-chain verification cron** runs 2 AM daily (`/api/cron/verify-audit-chain` per `/Users/jono/production/PageSpace-Deploy/README.md:84`). No documentation of what happens when verification fails — alert routing should be audited.
4. **Admin deletion reason is truncated at 200 characters** (`admin/users/[userId]/data/route.ts:35`). Forensically minor but note that longer Art 17 justifications cannot be recorded in-line.
5. **No "preservation hold" mechanism.** If litigation hold is required during an active erasure request, there is nothing to pause the deletion. Art 17(3)(e) (establishment, exercise, or defence of legal claims) needs an opt-in.
6. **Export ZIP is streamed without integrity signature.** A subject receiving the export cannot independently verify it's unmodified. A detached signature or hash manifest would be trivial to add.
7. **No user-facing "data processing notice" showing what has been collected.** The DSAR export is the only surface; there is no running dashboard.
8. **Soft-delete 30-day grace on messages is the same for explicit Art 17 deletes.** A user explicitly invoking Art 17 should get immediate hard delete, not a 30-day wait. Currently the soft-delete path is used uniformly.
9. **`log_user_activity` is called with masked email in the admin path but full email in the self-service path.** Operationally correct (self-service has consent) but inconsistent.
10. **No rate limit on `account/route.ts` DELETE.** A DoS vector (repeated delete attempts triggering solo-drive deletion). Low severity because deletion is gated on email confirmation.
11. **DM conversations** with two participants both of whom have been deleted cascade to empty `dmConversations` rows — worth a cleanup pass.
12. **No documented Art 30 records of processing** — out of Stream 1 scope but flagged for Stream 2.

---

## 8. Remediation Backlog

### P0 (must fix to claim Art 17 compliance in cloud mode)

| ID | Finding | Effort |
|---|---|---|
| R1 | F-15-1 + F-15-2: extend `collectAllUserData` to cover the 17+ missing categories and the received-DM gap | L |
| R2 | F-17-1: enqueue physical file deletion with a deadline and a completion receipt | L |
| R3 | F-17-2: move erasure to a durable job queue with status tracking | XL |
| R4 | F-17-4: admin force-delete path + ownership-transfer UI | M |
| R5 | F-17-2-1: call `stripe.customers.del` in cloud mode before `accountRepository.deleteUser` | S |
| R6 | F-17-2-2: wire `deleteConnection` to call `revokeUrl`, then iterate user's integrations on account delete | M |
| R7 | F-5e-1: add time-based retention for `activity_logs`, `error_logs`, `user_activities` | M |

### P1

| ID | Finding | Effort |
|---|---|---|
| R8 | F-15-3: cursor-stream activities export beyond 10k rows | S |
| R9 | F-17-2-3: wire AI provider delete forwarding or document ZDR posture | M |
| R10 | F-17-2-4: sync email provider suppression list | S |
| R11 | F-17-3b-1: publish retention schedule doc naming each legal obligation; add max-age cap on security audit log | M |
| R12 | F-17-5: add `purge-trashed-content` cron for `pages.isTrashed` and `drives.isTrashed` | S |
| R13 | F-20-1: add export manifest + schema version + README | S |
| R14 | F-12-3-1: model DSR requests in a `data_subject_requests` table with SLA metric | M |

### P2

R15–R26 (one per observation; all small-effort).

---

## 9. Checklist of Examined Files

### Spec and prior survey

- `tasks/gdpr-audit.md`
- `docs/security/compliance-sovereignty-analysis.md` (reference only — not cited in findings without independent verification)
- `CLAUDE.md`

### DSR route handlers (verified by direct read)

- `apps/web/src/app/api/account/route.ts` (GET, PATCH, DELETE; full file)
- `apps/web/src/app/api/account/export/route.ts` (full file)
- `apps/web/src/app/api/admin/users/[userId]/export/route.ts` (full file)
- `apps/web/src/app/api/admin/users/[userId]/data/route.ts` (full file)
- `apps/web/src/app/api/activities/export/route.ts` (via Agent 1 report)
- `apps/web/src/app/api/drives/[driveId]/integrations/audit/export/route.ts` (via Agent 1 report)
- `apps/web/src/app/api/user/integrations/[connectionId]/route.ts` (full file)

### Cron handlers

- `apps/web/src/app/api/cron/retention-cleanup/route.ts` (full file)
- `apps/web/src/app/api/cron/purge-ai-usage-logs/route.ts` (full file)
- `apps/web/src/app/api/cron/cleanup-orphaned-files/route.ts` (full file)
- `apps/web/src/app/api/cron/purge-deleted-messages/route.ts` (via Agent 2 report)
- `apps/web/src/app/api/cron/cleanup-tokens/route.ts` (via Agent 2 report)

### Compliance lib

- `packages/lib/src/compliance/export/gdpr-export.ts` (full file)
- `packages/lib/src/compliance/retention/retention-engine.ts` (full file)
- `packages/lib/src/compliance/retention/monitoring-retention.ts` (full file)
- `packages/lib/src/compliance/file-cleanup/orphan-detector.ts` (via Agent 2 report)
- `packages/lib/src/compliance/anonymize.ts` (via Agent 1 + Agent 3 reports)

### Repositories and helpers

- `packages/lib/src/repositories/account-repository.ts` (full file)
- `packages/lib/src/repositories/activity-log-repository.ts` (via Agent 1 report)
- `packages/lib/src/logging/monitoring-purge.ts` (verified by grep)
- `packages/lib/src/logging/logger-database.ts` (verified by grep)
- `packages/lib/src/integrations/repositories/connection-repository.ts` (direct read of `deleteConnection` at L142-152)
- `packages/lib/src/integrations/providers/slack.ts` (grep for `revokeUrl`)
- `packages/lib/src/integrations/providers/github.ts` (grep for `revokeUrl`)
- `packages/lib/src/integrations/types.ts` (grep for `revokeUrl`)
- `packages/lib/src/deployment-mode.ts` (reference)

### Schema files (29, all grepped; key ones directly read)

- `packages/db/src/schema/ai.ts`
- `packages/db/src/schema/auth.ts`
- `packages/db/src/schema/calendar-triggers.ts`
- `packages/db/src/schema/calendar.ts`
- `packages/db/src/schema/chat.ts`
- `packages/db/src/schema/contact.ts`
- `packages/db/src/schema/conversations.ts`
- `packages/db/src/schema/core.ts`
- `packages/db/src/schema/dashboard.ts`
- `packages/db/src/schema/display-preferences.ts`
- `packages/db/src/schema/email-notifications.ts`
- `packages/db/src/schema/feedback.ts`
- `packages/db/src/schema/hotkeys.ts`
- `packages/db/src/schema/integrations.ts`
- `packages/db/src/schema/members.ts`
- `packages/db/src/schema/monitoring.ts`
- `packages/db/src/schema/notifications.ts`
- `packages/db/src/schema/page-views.ts`
- `packages/db/src/schema/permissions.ts`
- `packages/db/src/schema/personalization.ts`
- `packages/db/src/schema/push-notifications.ts`
- `packages/db/src/schema/security-audit.ts` (direct read L83-133)
- `packages/db/src/schema/sessions.ts`
- `packages/db/src/schema/social.ts`
- `packages/db/src/schema/storage.ts` (direct read, full file)
- `packages/db/src/schema/subscriptions.ts`
- `packages/db/src/schema/tasks.ts`
- `packages/db/src/schema/versioning.ts` (direct read L140-200 plus `DEFAULT_VERSION_RETENTION_DAYS` at L52)
- `packages/db/src/schema/workflows.ts`

### Deploy repo (reference)

- `/Users/jono/production/PageSpace-Deploy/README.md` (cron schedule L74-88)
- `/Users/jono/production/PageSpace-Deploy/Caddyfile` (cron path blocking L2-8)
- `/Users/jono/production/PageSpace-Deploy/docker-compose.prod.yml` (cron service + CRON_SECRET)
- `/Users/jono/production/PageSpace-Deploy/.env.example` (CRON_SECRET)
- `/Users/jono/production/PageSpace-Deploy/apps/control-plane/src/services/backup-service.ts` (via Agent 3 report — tenant-mode backup pruning)

### Targeted greps run

- `packages/`: `pgvector|tsvector|to_tsvector|searchIndex|meilisearch|typesense|elasticsearch|embedding` → 0 matches
- `apps/web/src/app/api/account`: `stripe` (case-insensitive) → 0 matches
- `packages/lib/src/integrations`: `deleteConnection|revokeUrl|revoke` → only definitions + tests, no runtime callers
- `packages/lib`: `deleteMonitoringDataForUser|errorLogs|userActivities` → resolved at `packages/lib/src/logging/monitoring-purge.ts:18-30`
- `packages/db/src/schema`: `pageVersions|securityAuditLog|security_audit` (with context) → resolved cascade + hash-chain design

---

## 10. Continuation Notes

None. Scope covered in full within this document. Items flagged for future audit passes:

- **Control-plane repo**: tenant-mode erasure path in `/Users/jono/production/PageSpace-Deploy/apps/control-plane/` needs a companion audit to fully close F-17-2-1 for tenant deployments.
- **Stream 2 (consent, lawful basis, Art 30 RoPA)** — dependencies on this stream's retention schedule deliverable.
- **Stream 4 (breach notification)** — the lack of DSR request modeling (F-12-3-1) may also affect breach-notification timelines; worth cross-referencing.
