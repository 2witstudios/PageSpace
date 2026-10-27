-- Zero-trust role templates for the Admin PG trust plane (#890 Phase 1, leaf 4).
--
-- These are NOLOGIN role TEMPLATES. Actual login users are created per-deploy
-- by ops and attached with `GRANT <role> TO <login_user>`; no role defined
-- here can authenticate. Role creation is guarded (roles are cluster-scoped
-- and may pre-exist, e.g. from a sibling database or a re-provisioned DB in
-- the same cluster), and GRANT/REVOKE are natively idempotent, so this
-- migration is safe to re-run.
--
-- Grant matrix — DELETE and TRUNCATE are granted to NOBODY on any trust-plane
-- table. Append-only is enforced by the database itself; retention is a
-- future SECURITY DEFINER partition-drop function (leaf 6), never a DELETE.
--
--   role              security_audit_log            siem_delivery_cursors  siem_delivery_receipts
--   admin_app         SELECT, INSERT                —                      —
--   admin_chainer     SELECT, INSERT                —                      —
--   admin_gdpr_eraser SELECT, UPDATE(PII cols only) —                      —
--   admin_reader      SELECT                        SELECT                 SELECT
--   admin_siem        SELECT                        SELECT, INSERT, UPDATE SELECT, INSERT
--
-- admin_app: the web app's identity. INSERT for the current direct-write path
--   and SELECT because the pre-chainer cutover (Phase 2) still reads the chain
--   head. When the ingest table lands in Phase 2, ITS migration grants
--   admin_app INSERT-only on it.
-- admin_chainer: the processor's single-writer chain identity, staged here for
--   Phase 2. Its future ingest-drain DELETE grant applies ONLY to the Phase 2
--   ingest table — never to security_audit_log or any other chain table.
-- admin_gdpr_eraser: Art 17 erasure. Column-scoped UPDATE on exactly the PII
--   columns, which are hash-excluded by design, so erasure never breaks the
--   chain. No INSERT, no UPDATE on chain/content columns.
-- admin_reader: the admin app / chain verification. Read-only everywhere.
-- admin_siem: SIEM delivery worker. Reads all three tables; upserts cursors
--   (INSERT … ON CONFLICT DO UPDATE — see siem-delivery-worker.ts); receipts
--   are write-once (INSERT only, no UPDATE — ackReceivedAt is set at insert).
--
-- LEAF 6 / PHASE 2 NOTE: table-level grants do NOT survive DROP/re-CREATE.
-- The monthly-partitioning migration (leaf 6) re-creates security_audit_log
-- and MUST re-apply this file's security_audit_log grants on the new
-- partitioned parent (grants on the parent cascade to partitions, so one
-- re-apply suffices). Any future table added to the trust plane gets its
-- grants in its own migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'admin_app') THEN
    CREATE ROLE admin_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'admin_chainer') THEN
    CREATE ROLE admin_chainer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'admin_gdpr_eraser') THEN
    CREATE ROLE admin_gdpr_eraser NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'admin_reader') THEN
    CREATE ROLE admin_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'admin_siem') THEN
    CREATE ROLE admin_siem NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO admin_app, admin_chainer, admin_gdpr_eraser, admin_reader, admin_siem;
--> statement-breakpoint
-- Defense in depth: no ambient PUBLIC privilege on any trust-plane table.
REVOKE ALL ON security_audit_log, siem_delivery_cursors, siem_delivery_receipts FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON security_audit_log TO admin_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON security_audit_log TO admin_chainer;
--> statement-breakpoint
-- chain_seq is bigserial: INSERT with the column defaulted calls nextval(),
-- which requires USAGE on the backing sequence.
GRANT USAGE ON SEQUENCE security_audit_log_chain_seq_seq TO admin_app, admin_chainer;
--> statement-breakpoint
GRANT SELECT ON security_audit_log TO admin_gdpr_eraser;
--> statement-breakpoint
GRANT UPDATE (user_id, session_id, ip_address, ip_bidx, user_agent, geo_location) ON security_audit_log TO admin_gdpr_eraser;
--> statement-breakpoint
GRANT SELECT ON security_audit_log, siem_delivery_cursors, siem_delivery_receipts TO admin_reader;
--> statement-breakpoint
GRANT SELECT ON security_audit_log, siem_delivery_cursors, siem_delivery_receipts TO admin_siem;
--> statement-breakpoint
GRANT INSERT, UPDATE ON siem_delivery_cursors TO admin_siem;
--> statement-breakpoint
GRANT INSERT ON siem_delivery_receipts TO admin_siem;
