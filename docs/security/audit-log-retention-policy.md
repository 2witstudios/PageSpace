# Audit & Activity Log Retention Policy

This document describes retention for the audit/activity logging tables and the
configurable retention windows for monitoring data.

## Tables and their retention model

| Table | Retention | Mechanism |
|-------|-----------|-----------|
| `security_audit_log` | **Infinite** | Never deleted — tamper-evident hash chain requires an uninterrupted chain (GDPR Art 17(3)(b) legal-obligation justification). |
| `activity_logs` | **Infinite (rows), tiered visibility** | Never deleted (hash chain + rollback provenance). Old rows are flagged `isArchived = true` to keep the hot/active view bounded — see **Archival** below. |
| `api_metrics` | `RETENTION_API_METRICS_DAYS` (default 90) | Time-based delete. |
| `system_logs` | `RETENTION_SYSTEM_LOGS_DAYS` (default 30) | Time-based delete. |
| `error_logs` | `RETENTION_ERROR_LOGS_DAYS` (default 90) | Time-based delete. |
| `user_activities` | `RETENTION_USER_ACTIVITIES_DAYS` (default 180) | Time-based delete. |
| `ai_usage_logs` | `RETENTION_AI_USAGE_LOGS_DAYS` (default 90) | Time-based delete (purge-ai-usage-logs cron). |

All windows are positive integers (days). Unset, zero, negative, or non-numeric
values fall back to the defaults above. This makes retention tunable per
deployment (including tenant deployments) without a code change. See
`packages/lib/src/compliance/retention/monitoring-retention.ts`.

## Archival (`activity_logs` hot→cold tier)

`activity_logs` rows are **never deleted** — the tamper-evident hash chain
(`previousLogHash`, `logHash`, `chainSeed`, `chainSeq`) and rollback provenance
(`contentSnapshot`, `contentRef`, `previousValues`, `newValues`,
`rollbackFromActivityId`) must survive for chain verification and rollback.

Instead, a writer flips `isArchived = true` on rows older than a threshold so
the active-view filter (`isArchived = false`, used by the `/api/activities/**`
hot-path routes) narrows over time and query cost stays bounded as the table
grows.

**Job.** `apps/web/src/app/api/cron/archive-activity-logs/route.ts`, HMAC-validated
via `validateSignedCronRequest` on the same cadence as the other retention crons.

**Engine.** `packages/lib/src/compliance/retention/activity-log-archival.ts`:

- Selects up to `batchSize` not-yet-archived rows older than the cutoff
  (oldest first by `chainSeq`) and sets `isArchived = true` on exactly those ids.
- Batched and bounded by a per-run wall-clock budget to avoid long-held locks on
  a large table. The next batch re-filters on `isArchived = false`, so the window
  self-advances without an offset and cannot loop forever.
- **Flag flip ONLY.** The update payload is exactly `{ isArchived: true }`; it
  never touches any hash-chain or rollback-provenance field. `isArchived` is not
  a hash input (see `computeLogHash` / `hash-chain-verifier`), so chain
  verification is unaffected. The cron runs `quickIntegrityCheck` before and
  after each run and reports both as defense in depth.

**Configuration:**

| Env var | Default | Meaning |
|---------|---------|---------|
| `ACTIVITY_LOGS_ARCHIVE_DAYS` | 365 | Rows older than this are archived. |
| `ACTIVITY_LOGS_ARCHIVE_BATCH_SIZE` | 1000 | Rows flipped per batch. |
| `ACTIVITY_LOGS_ARCHIVE_MAX_RUN_MS` | 25000 | Per-run wall-clock budget. |

### Out of scope

- Cold storage / external sink (S3, Parquet, Snowflake) — separate epic.
- Time-based **deletion** of `activity_logs` — would break the hash chain and
  rollback provenance; we deliberately don't delete.
- Analogous treatment for `security_audit_log` — no `isArchived` field, different
  query profile; handle separately if ever needed.
