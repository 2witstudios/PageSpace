CREATE INDEX IF NOT EXISTS "idx_activity_logs_chain_seq" ON "activity_logs" USING btree ("chainSeq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_chain_seq" ON "security_audit_log" USING btree ("chain_seq");--> statement-breakpoint
ALTER TABLE "ai_usage_logs" DROP COLUMN IF EXISTS "prompt";--> statement-breakpoint
ALTER TABLE "ai_usage_logs" DROP COLUMN IF EXISTS "completion";