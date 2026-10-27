CREATE TABLE IF NOT EXISTS "security_audit_anchors" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"chain_seq" bigint NOT NULL,
	"head_hash" text NOT NULL,
	"anchored_at" timestamp with time zone NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_anchors_chain_seq" ON "security_audit_anchors" USING btree ("chain_seq");
--> statement-breakpoint
-- Zero-trust grants for the anchor receipt surface (#890 Phase 2, leaf 3).
--
-- security_audit_anchors is a WITNESS table: each row is a signed statement
-- "at chain_seq S the head was H, at time T" (HMAC-SHA256, see
-- packages/lib/src/audit/anchor.ts), published by the chainer beside the S3
-- Object-Lock copy. Its whole value is append-only-ness, so the matrix is
-- the narrowest in the trust plane:
--
--   role              security_audit_anchors
--   admin_chainer     INSERT only — fire-and-forget receipt; the publisher
--                     never reads back (no SELECT, INSERT … RETURNING fails)
--   admin_reader      SELECT — the anchor-match verifier reads anchors back
--   everyone else     nothing. NOBODY holds UPDATE, DELETE, or TRUNCATE:
--                     a compromised trust-plane credential can add anchors
--                     but never rewrite or remove a published one. (Retention
--                     is a non-goal — anchors are tiny and kept forever.)
--
-- id is cuid2 (publisher-minted) and created_at defaults to now(): no
-- sequence backs any column, so no sequence grants are needed.
REVOKE ALL ON security_audit_anchors FROM PUBLIC;
--> statement-breakpoint
GRANT INSERT ON security_audit_anchors TO admin_chainer;
--> statement-breakpoint
GRANT SELECT ON security_audit_anchors TO admin_reader;
