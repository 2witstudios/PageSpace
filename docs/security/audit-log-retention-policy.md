# Audit Log Retention Policy

> **Purpose:** Document the written retention policy and Art 17(3)(b)
> legal-obligation justification for log tables that are intentionally
> excluded from time-based purge.

## Scope

This policy applies to monitoring and audit tables in the PageSpace
PostgreSQL database. It does NOT cover application content (pages, drives,
files, chats) — those follow their own erasure rules under Art 17.

## Retention table

| Table | Retention window | Configurable via | Implementation |
|---|---|---|---|
| `system_logs` | 30 days | `RETENTION_SYSTEM_LOGS_DAYS` | `cleanupSystemLogs` in `packages/lib/src/compliance/retention/monitoring-retention.ts` |
| `api_metrics` | 90 days | `RETENTION_API_METRICS_DAYS` | `cleanupApiMetrics` |
| `error_logs` | 90 days | `RETENTION_ERROR_LOGS_DAYS` | `cleanupErrorLogs` |
| `user_activities` | 180 days | `RETENTION_USER_ACTIVITIES_DAYS` | `cleanupUserActivities` |
| `ai_usage_logs` | per-row `expiresAt` | n/a | `cleanupExpiredAiUsageLogs` (set by writer; default policy lives in the writer) |
| `activity_logs` | **infinite** (intentionally excluded) | n/a | See §"Art 17(3)(b) exemption" below |
| `security_audit_log` | **infinite** (intentionally excluded) | n/a | See §"Art 17(3)(b) exemption" below |

> **`user_activities` 180d rationale.** 180 days balances Art 5(1)(c)/(e)
> minimization against credential-stuffing and account-takeover detection
> windows, which typically span 90–180 days per EDPB Guidelines 9/2022 on
> personal data breach notification. Operators who determine 90d is
> sufficient for detection needs can tighten via
> `RETENTION_USER_ACTIVITIES_DAYS`.

## Cron cadence

Time-based purges run via:

- `apps/web/src/app/api/cron/retention-cleanup/route.ts` — daily, calls
  `runRetentionCleanup` which fans out to `runMonitoringRetentionCleanup`
  in parallel
- `apps/web/src/app/api/cron/purge-ai-usage-logs/route.ts` — daily, AI
  usage log expiry sweep
- `apps/web/src/app/api/cron/verify-audit-chain/route.ts` — daily, hash
  chain integrity verification (does NOT delete; alerts on tampering)

All cron endpoints require an HMAC-signed request via
`validateSignedCronRequest`.

## Art 17(3)(b) exemption — `security_audit_log` and `activity_logs`

GDPR Art 17(3)(b) carves an exemption to the right to erasure where
processing is necessary "for compliance with a legal obligation which
requires processing by Union or Member State law to which the controller
is subject."

PageSpace invokes this exemption for **both** `security_audit_log` and
`activity_logs` on the following grounds. Each ground applies to both
tables; grounds 1–3 are shared, and ground 4 adds an `activity_logs`-
specific contractual-performance basis.

1. **Tamper-evidence integrity.** Both tables cryptographically chain
   each entry to the previous via `computeLogHash` (see
   `packages/lib/src/monitoring/activity-logger.ts` and
   `packages/lib/src/monitoring/hash-chain-verifier.ts`). `activity_logs`
   carries `previousLogHash`, `logHash`, and `chainSeed` at
   `packages/db/src/schema/monitoring.ts:389-391`; `security_audit_log`
   carries the same pattern at
   `packages/db/src/schema/security-audit.ts`. Deleting any entry —
   including a deleted user's entries — breaks the chain and
   invalidates every subsequent verification. There is no hash-
   preserving way to remove individual rows without producing a
   forensically indistinguishable result from tampering.

2. **Security incident response and breach detection.** Art 32(1) requires
   the controller to implement appropriate technical measures including
   "the ability to detect, investigate, and report" personal data breaches.
   Art 33 requires breach notification to the supervisory authority within
   72 hours of becoming aware. Both obligations require an audit trail
   that survives long enough to investigate incidents that may be
   discovered weeks or months after the fact. Both tables carry the
   forensic trail: `security_audit_log` for auth / privilege / admin
   events, `activity_logs` for content / resource / drive events.

3. **Anti-fraud and abuse prevention.** Authentication events, privilege
   escalations, admin actions, and content modifications are recorded
   for the legitimate interest in detecting credential stuffing, account
   takeover, and insider abuse — Art 6(1)(f) plus EDPB Guidelines 9/2022
   on personal data breach notification.

4. **Rollback provenance and deterministic event replay
   (`activity_logs` specifically).** `activity_logs` stores
   `contentSnapshot`, `contentRef`, `previousValues`, `newValues`,
   `rollbackFromActivityId`, and the stream fields (`streamId` /
   `streamSeq` / `changeGroupId` / `stateHashBefore` / `stateHashAfter`)
   which implement point-in-time rollback for page and drive
   operations. Deleting source activities breaks rollback for every
   downstream operation that references them and breaks deterministic
   replay of the event stream. Retention is necessary for **contractual
   performance** (Art 6(1)(b)) of the rollback / versioning features the
   product promises to users, independent of the hash-chain ground.

### What the exemption does NOT cover

- **Application content** in pages, drives, files, chats. Those are
  governed by Art 17 with no exemption and follow the standard erasure
  flow at `apps/web/src/app/api/account/route.ts`.
- **Per-user metadata in non-audit monitoring tables.** `system_logs`,
  `api_metrics`, `error_logs`, and `user_activities` are user-purgeable
  on account deletion via
  `packages/lib/src/logging/monitoring-purge.ts`'s
  `deleteMonitoringDataForUser` and time-purgeable via the cron above.
- **`security_audit_log` rows that contain unnecessary PII.** The
  exemption justifies retaining the *fact* of an event (timestamp, event
  type, hash chain), not arbitrary PII embedded in the event payload.
  Writers must minimize what they put in `details` per Art 5(1)(c).
- **`activity_logs` content payloads.** The exemption justifies retaining
  the fact of an activity (timestamp, actor snapshot, operation, resource,
  hash chain, rollback linkage), not arbitrary content embedded in
  `contentSnapshot`, `previousValues`, or `newValues`. Writers must
  minimize payload fields per Art 5(1)(c); large content should flow
  through `contentRef` to a content-addressed store with its own
  retention policy.

## Per-user erasure path

`deleteMonitoringDataForUser(userId)` runs synchronously during account
deletion and purges the user's rows from `system_logs`, `api_metrics`,
`error_logs`, and `user_activities`. Both `security_audit_log` and
`activity_logs` are intentionally excluded under Art 17(3)(b).

For `activity_logs`, the schema already implements the pseudonymization
fallback natively: `userId`, `driveId`, and `pageId` use
`onDelete: 'set null'` (see `packages/db/src/schema/monitoring.ts:333`,
`:353`, `:354`), so account-deletion FK cascade drops the join without
breaking the row; the denormalized `actorEmail` defaults to
`'legacy@unknown'` (line 336) and `actorDisplayName` is nullable
(line 337), so an Art 17 request can be honored by overwriting these
columns to anonymized values without row deletion or hash-chain
disturbance.

For `security_audit_log`, the fallback is pseudonymization of `userId`
columns, **not** row deletion (which would break the chain).

If a user has lodged an Art 17 request and the supervisory authority
disputes the Art 17(3)(b) invocation for either table, the answer is
this pseudonymization path. Tracking implementation of the
pseudonymization helpers: see issue #985.

## Planned (not yet implemented)

`activity_logs.isArchived` is read as a hot/cold visibility filter by
routes under `apps/web/src/app/api/activities/**` (the default view
filters on `eq(activityLogs.isArchived, false)`), but no writer
currently flips the flag to `true`. A future hot→cold tiering job will
archive aged rows in place, preserving the hash chain and rollback
provenance while dropping them from the active view. **No time-based
deletion is planned**; archival moves rows between visibility tiers,
not out of the table. Tracking: see issue #984.

## Review cadence

This policy should be reviewed:

- Whenever a new monitoring table is added to `packages/db/src/schema/`
- Whenever a retention default in `monitoring-retention.ts` changes
- At least annually

## References

- GDPR Art 5(1)(c), 5(1)(e), 6(1)(b), 6(1)(f), 17, 17(3)(b), 32(1), 33
- EDPB Guidelines 9/2022 on personal data breach notification
- `packages/lib/src/compliance/retention/monitoring-retention.ts`
- `packages/lib/src/logging/monitoring-purge.ts`
- `packages/lib/src/monitoring/hash-chain-verifier.ts`
- `packages/lib/src/monitoring/activity-logger.ts` — activity_logs writer and hash-chain producer
- `packages/db/src/schema/monitoring.ts` — activity_logs schema (actor snapshot, hash chain, rollback fields)
- `packages/db/src/schema/security-audit.ts` — security_audit_log schema
- `apps/web/src/app/api/activities/` — hot-view routes filtering on `isArchived = false`
- `apps/web/src/app/api/cron/verify-audit-chain/route.ts`
- Follow-up issues: #984 (activity_logs tiering writer), #985 (Art 17 pseudonymization helpers)
