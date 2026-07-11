CREATE TABLE IF NOT EXISTS "security_audit_ingest" (
	"id" text PRIMARY KEY NOT NULL,
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
	"emission_hash" text NOT NULL,
	"emitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_ingest_drain" ON "security_audit_ingest" USING btree ("emitted_at","id");
--> statement-breakpoint
-- Zero-trust grants for the emission queue (#890 Phase 2, leaf 1).
--
-- security_audit_ingest is a TRANSIENT queue, not a chain table: the app
-- fire-and-forgets rows in, the single-writer chainer drains them out. The
-- grant matrix is accordingly narrower than the chain tables':
--
--   role              security_audit_ingest
--   admin_app         INSERT only — fire-and-forget; the writer never reads
--                     back (no SELECT, so even INSERT … RETURNING would fail)
--   admin_chainer     SELECT + DELETE — the drain. This fulfills the DELETE
--                     grant deferred by 0001 ("applies ONLY to the Phase 2
--                     ingest table") and is the ONLY DELETE grant in the
--                     trust plane. admin_chainer still cannot INSERT here
--                     (rows enter via admin_app) and still holds no DELETE
--                     on security_audit_log or any other table.
--   admin_reader      SELECT (verification / cross-check visibility)
--   everyone else     nothing (admin_gdpr_eraser erases on the durable chain
--                     table — queue rows live too briefly to be an Art 17
--                     surface; admin_siem reads the chain post-cutover, never
--                     the queue; admin_maintenance owns no table privileges)
--
-- id is cuid2 (app-generated) and emitted_at defaults to now(): no sequence
-- backs any column, so no sequence grants are needed.
REVOKE ALL ON security_audit_ingest FROM PUBLIC;
--> statement-breakpoint
GRANT INSERT ON security_audit_ingest TO admin_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON security_audit_ingest TO admin_chainer;
--> statement-breakpoint
GRANT SELECT ON security_audit_ingest TO admin_reader;