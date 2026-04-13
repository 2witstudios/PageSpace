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
| `activity_logs` | per-row `expiresAt` (where set) | n/a | `cleanupExpiredActivityLogs` |
| `security_audit_log` | **infinite** (intentionally excluded) | n/a | See §"Art 17(3)(b) exemption" below |

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

## Art 17(3)(b) exemption — `security_audit_log`

GDPR Art 17(3)(b) carves an exemption to the right to erasure where
processing is necessary "for compliance with a legal obligation which
requires processing by Union or Member State law to which the controller
is subject."

PageSpace invokes this exemption for `security_audit_log` on three
grounds:

1. **Tamper-evidence integrity.** Each entry is cryptographically chained
   to the previous via `computeLogHash` (see
   `packages/lib/src/monitoring/activity-logger.ts` and
   `packages/lib/src/monitoring/hash-chain-verifier.ts`). Deleting any
   entry — including a deleted user's entries — breaks the chain and
   invalidates every subsequent verification. There is no hash-preserving
   way to remove individual rows without producing a forensically
   indistinguishable result from tampering.

2. **Security incident response and breach detection.** Art 32(1) requires
   the controller to implement appropriate technical measures including
   "the ability to detect, investigate, and report" personal data breaches.
   Art 33 requires breach notification to the supervisory authority within
   72 hours of becoming aware. Both obligations require an audit trail
   that survives long enough to investigate incidents that may be
   discovered weeks or months after the fact.

3. **Anti-fraud and abuse prevention.** Authentication events, privilege
   escalations, and admin actions are recorded here for the legitimate
   interest in detecting credential stuffing, account takeover, and
   insider abuse — Art 6(1)(f) plus EDPB Guidelines 9/2022 on personal
   data breach notification.

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

## Per-user erasure path

`deleteMonitoringDataForUser(userId)` runs synchronously during account
deletion and purges the user's rows from `system_logs`, `api_metrics`,
`error_logs`, `user_activities`. `security_audit_log` is intentionally
excluded under Art 17(3)(b). If a user has lodged an Art 17 request and
the supervisory authority disputes the Art 17(3)(b) invocation, the
fallback is pseudonymization of `userId` columns in
`security_audit_log`, NOT row deletion (which would break the chain).

## Review cadence

This policy should be reviewed:

- Whenever a new monitoring table is added to `packages/db/src/schema/`
- Whenever a retention default in `monitoring-retention.ts` changes
- At least annually

## References

- GDPR Art 5(1)(c), 5(1)(e), 17, 17(3)(b), 32(1), 33
- `packages/lib/src/compliance/retention/monitoring-retention.ts`
- `packages/lib/src/logging/monitoring-purge.ts`
- `packages/lib/src/monitoring/hash-chain-verifier.ts`
- `apps/web/src/app/api/cron/verify-audit-chain/route.ts`
