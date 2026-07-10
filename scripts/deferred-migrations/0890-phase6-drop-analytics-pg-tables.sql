-- ════════════════════════════════════════════════════════════════════════════
-- DEFERRED — DO NOT RUN BEFORE #890 PHASE 6 (task kws85p45pvjnivoz3uxs83yp)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Drops the 4 analytics tables from MAIN PG after the ClickHouse cutover
-- (#890 Phase 3). Authored by Phase 3 leaf 4; execution deliberately deferred:
-- there is NO backfill of pre-cutover analytics rows into ClickHouse, so
-- running this before the Phase 6 history decision (task f70ay5fo488veub4fak4feqs
-- — backfill vs age-out) destroys the only copy of [start→cutover] metrics,
-- logs, activities, and errors.
--
-- PRECONDITIONS (all must hold before removing the guard below):
--   1. CLICKHOUSE_ENABLED=true in the target environment, soaked, with the
--      monitoring UIs reading CH (Phase 3 leaf 3) and inserts flowing
--      (Phase 3 leaf 2). scripts/clickhouse-migrate.ts already applied.
--   2. The pre-cutover-history decision task f70ay5fo488veub4fak4feqs is
--      resolved (history backfilled into CH, or explicitly aged out /
--      accepted as lost).
--   3. GDPR erasure/export against CH is live (Phase 3 leaf 4:
--      analytics-gdpr.ts) — after the drop it is the ONLY copy.
--
-- CANONICAL EXECUTION PATH (preferred over psql -f of this file):
--   delete the four pgTable definitions + their relations from
--   packages/db/src/schema/monitoring.ts (KEEP errorResolutions, aiUsageLogs,
--   activityLogs), run `bun run db:generate`, and ship the generated
--   migration — this file is the reviewed reference for what that migration
--   must contain, and the break-glass manual fallback.
--   In the same change, delete the now-dead off-mode PG code paths:
--   apps/admin + apps/web monitoring-queries PG branches, the PG legs in
--   gdpr-export.ts / monitoring-purge.ts / monitoring-retention.ts, and the
--   errorLogs fallback in observability/error-resolutions.ts
--   (fetchRecentErrors).
--
-- What stays in main PG, permanently:
--   error_resolutions (mutable resolved-flag workflow — CH rows are immutable),
--   ai_usage_logs (billing joins + cost-reconcile UPDATEs; Phase 4 CDC),
--   activity_logs (hash-chained; Phase 5 owns its move).
-- Admin PG chain tables (security_audit_log, siem_delivery_receipts) are
-- untouchable by design: infinite retention, create-ahead-only partitions,
-- no drop path exists (Art 17(3)(b); drizzle-admin/0002).

-- Guard: makes an accidental execution fail loudly. Remove ONLY as part of
-- the Phase 6 task above, with the preconditions checked off.
DO $$
BEGIN
  RAISE EXCEPTION '#890: deferred to Phase 6 task kws85p45pvjnivoz3uxs83yp — pre-cutover analytics history is not backfilled to ClickHouse; see header before removing this guard';
END
$$;

-- Indexes, sequences, and FK constraints owned by these tables drop with them.
-- No inbound FKs exist (telemetry tables; verified at authoring time).
DROP TABLE IF EXISTS "api_metrics";
DROP TABLE IF EXISTS "system_logs";
DROP TABLE IF EXISTS "user_activities";
DROP TABLE IF EXISTS "error_logs";
