# Audit & Activity Log Retention Policy

This document describes retention for the audit/activity logging tables and the
configurable retention windows for monitoring data.

## Tables and their retention model

| Table | Retention | Mechanism |
|-------|-----------|-----------|
| `security_audit_log` (Admin PG) | **Infinite** | Never deleted — tamper-evident hash chain requires an uninterrupted chain (GDPR Art 17(3)(b) legal-obligation justification). Monthly partitions exist for index/vacuum bounding only; `admin_ensure_partitions` is create-ahead ONLY, no drop path exists (`drizzle-admin/0002`, pinned by `admin-partition-migration.test.ts`). |
| `siem_delivery_receipts` (Admin PG) | **Infinite** | Never deleted — receipts are the external-witness half of the anchoring evidence (paired with S3 Object-Lock anchors); dropping them would truncate the proof trail the infinite-retention chain relies on. Same create-ahead-only partition maintenance as above, deliberately without a drop path. |
| `activity_logs` | **Infinite (rows), tiered visibility** | Never deleted (hash chain + rollback provenance). Old rows are flagged `isArchived = true` to keep the hot/active view bounded — see **Archival** below. |
| `api_metrics` | `RETENTION_API_METRICS_DAYS` (default 90) | PG time-based delete; **CH mode: 90-day table TTL**. |
| `system_logs` | `RETENTION_SYSTEM_LOGS_DAYS` (default 30) | PG time-based delete; **CH mode: 30-day table TTL**. |
| `error_logs` | `RETENTION_ERROR_LOGS_DAYS` (default 90) | PG time-based delete; **CH mode: NO TTL by design** — GDPR erasure mutations (`observability/analytics-gdpr.ts`) are the only eraser. |
| `user_activities` | `RETENTION_USER_ACTIVITIES_DAYS` (default 180) | PG time-based delete; **CH mode: 180-day table TTL**. |
| `ai_usage_logs` | `RETENTION_AI_USAGE_LOGS_DAYS` (default 90) | Time-based delete (purge-ai-usage-logs cron). Stays in main PG permanently. |

All windows are positive integers (days). Unset, zero, negative, or non-numeric
values fall back to the defaults above. This makes retention tunable per
deployment (including tenant deployments) without a code change. See
`packages/lib/src/compliance/retention/monitoring-retention.ts`.

## ClickHouse analytics tier (#890 Phase 3)

With `CLICKHOUSE_ENABLED=true`, new rows for the 4 analytics tables
(`api_metrics`, `system_logs`, `user_activities`, `error_logs`) land only in
ClickHouse. Retention for **three** of them (`api_metrics` 90d, `system_logs`
30d, `user_activities` 180d) is enforced by the table TTLs above
(`packages/lib/src/observability/clickhouse-ddl.ts`); `error_logs` carries **NO
TTL by design** and is erased solely by GDPR mutations (see its row above and
`observability/analytics-gdpr.ts`). In that mode
`runMonitoringRetentionCleanup` is a no-op for those tables — the PG copies
hold only frozen pre-cutover history until the deferred Phase 6 drop
(`scripts/deferred-migrations/0890-phase6-drop-analytics-pg-tables.sql`).
GDPR Art 15 export unions both stores and Art 17 erasure deletes from both
stores while that transition window is open (`gdpr-export.ts`,
`monitoring-purge.ts`).

**TTL timing.** ClickHouse removes TTL-expired *stored* rows lazily, during
background part merges (or an explicit `OPTIMIZE TABLE … FINAL`) — an aged row
can stay queryable until its part is next merged, so the windows above are
upper bounds on visibility, not exact. Separately, because `optimize_on_insert`
is on by default, a row **inserted** with a timestamp already past the table's
TTL horizon is dropped at insert time — which is what constrains any future
PG→CH history backfill (backfilled rows older than the horizon silently vanish).

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
via `validateSignedCronRequest`, registered in `docker/cron/crontab` (daily at
02:30 UTC, alongside the other retention/purge jobs).

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
