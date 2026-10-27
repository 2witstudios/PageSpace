-- Monthly RANGE partitioning for the Admin PG chain tables (#890 Phase 1, leaf 6).
--
-- security_audit_log receives a write on every authenticated request, forever,
-- with legally mandated infinite retention (Art 17(3)(b)); unpartitioned, its
-- indexes and vacuum costs grow without bound. siem_delivery_receipts is
-- likewise append-only and unbounded. Monthly partitions bound per-partition
-- index size and vacuum work. siem_delivery_cursors (tiny, upserted) stays
-- plain and is untouched here.
--
-- drizzle-kit cannot express partitioning declaratively, so this is a custom
-- migration (generate --custom); the Drizzle schema factory is unchanged and
-- byte-compatible column-wise, so db:generate:admin still reports no changes.
--
-- PK REWORK (documented tradeoff): PostgreSQL requires the partition key in
-- every PK/unique constraint on a partitioned table.
--   security_audit_log:      PRIMARY KEY (id)        -> (id, timestamp)
--   siem_delivery_receipts:  PRIMARY KEY (receiptId) -> (receiptId, deliveredAt)
--   siem_delivery_receipts:  UNIQUE (deliveryId, source) -> (deliveryId, source, deliveredAt)
-- Consequences accepted: global id-uniqueness is no longer DB-enforced across
-- partitions (ids are cuid2, collision odds negligible, and nothing does
-- ON CONFLICT on either table -- verified against siem-receipt-writer.ts,
-- which uses plain multi-row INSERT); point lookups by bare id scan one index
-- per partition (bounded, and forensic queries are time-scoped anyway). The
-- Drizzle schema still declares the single-column PK -- a type-level fiction
-- that affects no runtime query; adjusting it would make drizzle-kit diff.
--
-- chain_seq: the bigserial's backing sequence security_audit_log_chain_seq_seq
-- SURVIVES the re-create -- detached (OWNED BY NONE) before the old table is
-- dropped, reused as the new column's DEFAULT, then re-owned. Values continue
-- without reset and leaf 4's sequence USAGE grants carry over (re-asserted
-- below anyway). The chain-head query (ORDER BY chain_seq DESC LIMIT 1) stays
-- index-fast via the partitioned idx_security_audit_chain_seq.
--
-- NO DROP PATH: chain tables have infinite retention. admin_ensure_partitions
-- is create-ahead ONLY -- it contains no drop code path at all, and EXECUTE is
-- granted solely to admin_maintenance (which holds no table privileges and
-- owns nothing, so it cannot drop partitions either). Partition-DROP retention
-- for analytics lives in ClickHouse TTLs (Phase 3), never here. The two DROP
-- TABLE statements below remove only the emptied pre-partitioning tables after
-- their rows are copied -- they are the swap, not a retention path.
--
-- OPERATIONAL CADENCE: the migration seeds partitions covering any existing
-- data range plus current + 3 months ahead + DEFAULT safety nets. A cron
-- (Phase 6 runbook) calls SELECT admin_ensure_partitions(3) monthly as
-- admin_maintenance to keep the horizon. If the cron dies, inserts fall into
-- the DEFAULT partition and are never lost; note that creating a monthly
-- partition later FAILS while DEFAULT holds rows for that month -- ops must
-- then move those rows out of DEFAULT first (Postgres semantics, deliberately
-- not automated here).
--
-- GRANTS: table grants die with DROP TABLE, so leaf 4's full grant matrix for
-- the two re-created parents is re-applied verbatim at the end (grants on a
-- partitioned parent cascade to partitions -- access via the parent checks
-- only parent ACLs, so future partitions need nothing).

ALTER SEQUENCE "security_audit_log_chain_seq_seq" OWNED BY NONE;
--> statement-breakpoint
ALTER TABLE "security_audit_log" RENAME TO "security_audit_log_unpartitioned";
--> statement-breakpoint
ALTER TABLE "siem_delivery_receipts" RENAME TO "siem_delivery_receipts_unpartitioned";
--> statement-breakpoint
-- Renaming a table does NOT rename its constraints; free the pkey names for
-- the partitioned parents (the old tables are dropped after the copy anyway).
ALTER TABLE "security_audit_log_unpartitioned" RENAME CONSTRAINT "security_audit_log_pkey" TO "security_audit_log_unpartitioned_pkey";
--> statement-breakpoint
ALTER TABLE "siem_delivery_receipts_unpartitioned" RENAME CONSTRAINT "siem_delivery_receipts_pkey" TO "siem_delivery_receipts_unpartitioned_pkey";
--> statement-breakpoint
CREATE TABLE "security_audit_log" (
	"id" text NOT NULL,
	"event_type" text NOT NULL,
	"user_id" text,
	"session_id" text,
	"service_id" text,
	"resource_type" text,
	"resource_id" text,
	"ip_address" text,
	"ip_bidx" text,
	"user_agent" text,
	"geo_location" text,
	"details" jsonb,
	"risk_score" real,
	"anomaly_flags" text[],
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"chain_seq" bigint DEFAULT nextval('security_audit_log_chain_seq_seq') NOT NULL,
	"previous_hash" text NOT NULL,
	"event_hash" text NOT NULL,
	CONSTRAINT "security_audit_log_pkey" PRIMARY KEY ("id", "timestamp")
) PARTITION BY RANGE ("timestamp");
--> statement-breakpoint
ALTER SEQUENCE "security_audit_log_chain_seq_seq" OWNED BY "security_audit_log"."chain_seq";
--> statement-breakpoint
CREATE TABLE "siem_delivery_receipts" (
	"receiptId" text NOT NULL,
	"deliveryId" text NOT NULL,
	"source" text NOT NULL,
	"firstEntryId" text NOT NULL,
	"lastEntryId" text NOT NULL,
	"firstEntryTimestamp" timestamp NOT NULL,
	"lastEntryTimestamp" timestamp NOT NULL,
	"entryCount" integer NOT NULL,
	"deliveredAt" timestamp NOT NULL,
	"webhookStatus" integer,
	"webhookResponseHash" text,
	"ackReceivedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "siem_delivery_receipts_pkey" PRIMARY KEY ("receiptId", "deliveredAt")
) PARTITION BY RANGE ("deliveredAt");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'admin_maintenance') THEN
    CREATE ROLE admin_maintenance NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_ensure_partitions(months_ahead integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  parent text;
  month_start date;
  part_name text;
  created integer := 0;
BEGIN
  IF months_ahead < 0 OR months_ahead > 120 THEN
    RAISE EXCEPTION 'admin_ensure_partitions: months_ahead must be between 0 and 120, got %', months_ahead;
  END IF;
  FOREACH parent IN ARRAY ARRAY['security_audit_log', 'siem_delivery_receipts'] LOOP
    part_name := parent || '_default';
    IF to_regclass(part_name) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF %I DEFAULT', part_name, parent);
      created := created + 1;
    END IF;
    FOR i IN 0..months_ahead LOOP
      month_start := (date_trunc('month', now()) + make_interval(months => i))::date;
      part_name := parent || '_p' || to_char(month_start, 'YYYY_MM');
      IF to_regclass(part_name) IS NULL THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
          part_name, parent, month_start, (month_start + interval '1 month')::date
        );
        created := created + 1;
      END IF;
    END LOOP;
  END LOOP;
  RETURN created;
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_ensure_partitions(integer) FROM PUBLIC;
--> statement-breakpoint
-- Schema USAGE is required just to RESOLVE the function name (0001 granted it
-- to the five leaf-4 roles; admin_maintenance is new here). It confers no
-- table access.
GRANT USAGE ON SCHEMA public TO admin_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_ensure_partitions(integer) TO admin_maintenance;
--> statement-breakpoint
SELECT admin_ensure_partitions(3);
--> statement-breakpoint
DO $$
DECLARE
  month_start date;
  current_month date;
BEGIN
  SELECT date_trunc('month', min("timestamp"))::date INTO month_start
    FROM "security_audit_log_unpartitioned";
  IF month_start IS NOT NULL THEN
    current_month := date_trunc('month', now())::date;
    WHILE month_start < current_month LOOP
      IF to_regclass('security_audit_log_p' || to_char(month_start, 'YYYY_MM')) IS NULL THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF security_audit_log FOR VALUES FROM (%L) TO (%L)',
          'security_audit_log_p' || to_char(month_start, 'YYYY_MM'),
          month_start, (month_start + interval '1 month')::date
        );
      END IF;
      month_start := (month_start + interval '1 month')::date;
    END LOOP;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
DECLARE
  month_start date;
  current_month date;
BEGIN
  SELECT date_trunc('month', min("deliveredAt"))::date INTO month_start
    FROM "siem_delivery_receipts_unpartitioned";
  IF month_start IS NOT NULL THEN
    current_month := date_trunc('month', now())::date;
    WHILE month_start < current_month LOOP
      IF to_regclass('siem_delivery_receipts_p' || to_char(month_start, 'YYYY_MM')) IS NULL THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF siem_delivery_receipts FOR VALUES FROM (%L) TO (%L)',
          'siem_delivery_receipts_p' || to_char(month_start, 'YYYY_MM'),
          month_start, (month_start + interval '1 month')::date
        );
      END IF;
      month_start := (month_start + interval '1 month')::date;
    END LOOP;
  END IF;
END
$$;
--> statement-breakpoint
INSERT INTO "security_audit_log" ("id", "event_type", "user_id", "session_id", "service_id",
	"resource_type", "resource_id", "ip_address", "ip_bidx", "user_agent", "geo_location",
	"details", "risk_score", "anomaly_flags", "timestamp", "chain_seq", "previous_hash", "event_hash")
SELECT "id", "event_type", "user_id", "session_id", "service_id",
	"resource_type", "resource_id", "ip_address", "ip_bidx", "user_agent", "geo_location",
	"details", "risk_score", "anomaly_flags", "timestamp", "chain_seq", "previous_hash", "event_hash"
FROM "security_audit_log_unpartitioned";
--> statement-breakpoint
INSERT INTO "siem_delivery_receipts" ("receiptId", "deliveryId", "source", "firstEntryId", "lastEntryId",
	"firstEntryTimestamp", "lastEntryTimestamp", "entryCount", "deliveredAt",
	"webhookStatus", "webhookResponseHash", "ackReceivedAt", "createdAt")
SELECT "receiptId", "deliveryId", "source", "firstEntryId", "lastEntryId",
	"firstEntryTimestamp", "lastEntryTimestamp", "entryCount", "deliveredAt",
	"webhookStatus", "webhookResponseHash", "ackReceivedAt", "createdAt"
FROM "siem_delivery_receipts_unpartitioned";
--> statement-breakpoint
DROP TABLE "security_audit_log_unpartitioned";
--> statement-breakpoint
DROP TABLE "siem_delivery_receipts_unpartitioned";
--> statement-breakpoint
CREATE INDEX "idx_security_audit_timestamp" ON "security_audit_log" USING btree ("timestamp");
--> statement-breakpoint
CREATE INDEX "idx_security_audit_user_timestamp" ON "security_audit_log" USING btree ("user_id","timestamp");
--> statement-breakpoint
CREATE INDEX "idx_security_audit_event_type" ON "security_audit_log" USING btree ("event_type","timestamp");
--> statement-breakpoint
CREATE INDEX "idx_security_audit_resource" ON "security_audit_log" USING btree ("resource_type","resource_id","timestamp");
--> statement-breakpoint
CREATE INDEX "idx_security_audit_ip" ON "security_audit_log" USING btree ("ip_address","timestamp");
--> statement-breakpoint
CREATE INDEX "idx_security_audit_ip_bidx" ON "security_audit_log" USING btree ("ip_bidx","timestamp");
--> statement-breakpoint
CREATE INDEX "idx_security_audit_event_hash" ON "security_audit_log" USING btree ("event_hash");
--> statement-breakpoint
CREATE INDEX "idx_security_audit_chain_seq" ON "security_audit_log" USING btree ("chain_seq");
--> statement-breakpoint
CREATE INDEX "idx_security_audit_risk_score" ON "security_audit_log" USING btree ("risk_score");
--> statement-breakpoint
CREATE INDEX "idx_security_audit_session" ON "security_audit_log" USING btree ("session_id","timestamp");
--> statement-breakpoint
CREATE UNIQUE INDEX "siem_delivery_receipts_delivery_source_unique" ON "siem_delivery_receipts" USING btree ("deliveryId","source","deliveredAt");
--> statement-breakpoint
CREATE INDEX "idx_siem_receipts_delivery_id" ON "siem_delivery_receipts" USING btree ("deliveryId");
--> statement-breakpoint
CREATE INDEX "idx_siem_receipts_first_entry" ON "siem_delivery_receipts" USING btree ("firstEntryId");
--> statement-breakpoint
CREATE INDEX "idx_siem_receipts_last_entry" ON "siem_delivery_receipts" USING btree ("lastEntryId");
--> statement-breakpoint
CREATE INDEX "idx_siem_receipts_delivered_at" ON "siem_delivery_receipts" USING btree ("deliveredAt");
--> statement-breakpoint
CREATE INDEX "idx_siem_receipts_source_range" ON "siem_delivery_receipts" USING btree ("source","firstEntryTimestamp","lastEntryTimestamp");
--> statement-breakpoint
REVOKE ALL ON security_audit_log, siem_delivery_receipts FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON security_audit_log TO admin_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON security_audit_log TO admin_chainer;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE security_audit_log_chain_seq_seq TO admin_app, admin_chainer;
--> statement-breakpoint
GRANT SELECT ON security_audit_log TO admin_gdpr_eraser;
--> statement-breakpoint
GRANT UPDATE (user_id, session_id, ip_address, ip_bidx, user_agent, geo_location) ON security_audit_log TO admin_gdpr_eraser;
--> statement-breakpoint
GRANT SELECT ON security_audit_log, siem_delivery_receipts TO admin_reader;
--> statement-breakpoint
GRANT SELECT ON security_audit_log, siem_delivery_receipts TO admin_siem;
--> statement-breakpoint
GRANT INSERT ON siem_delivery_receipts TO admin_siem;
