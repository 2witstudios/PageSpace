-- 0109: Add chain_seq for deterministic hash chain ordering
--
-- Replaces timestamp-based predecessor selection with bigserial commit order.
-- Fixes hash chain forking: under pg_advisory_xact_lock, writers queue and
-- capture their timestamp before acquiring the lock. When commit order and
-- timestamp order diverge, ORDER BY timestamp DESC returns a stale predecessor
-- and the chain forks. chain_seq is assigned by the DB at commit time, so it
-- is always monotone within the lock.
--
-- Also resets SIEM delivery cursors: 0106 nulled logHash on activity_logs
-- rows and 0107 truncated security_audit_log. Both leave lastDeliveredId
-- pointing at rows whose anchor hash is NULL or gone — runChainPreflight
-- fails closed and halts SIEM delivery permanently. Nulling the cursors
-- restores the fresh-cursor path so delivery can resume.

ALTER TABLE "activity_logs" ADD COLUMN "chainSeq" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "security_audit_log" ADD COLUMN "chain_seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_logs_chain_seq" ON "activity_logs" USING btree ("chainSeq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_chain_seq" ON "security_audit_log" USING btree ("chain_seq");--> statement-breakpoint
UPDATE siem_delivery_cursors
SET "lastDeliveredId" = NULL,
    "lastDeliveredAt" = NULL
WHERE id IN ('activity_logs', 'security_audit_log');
