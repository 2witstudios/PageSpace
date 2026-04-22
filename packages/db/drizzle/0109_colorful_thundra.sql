ALTER TABLE "activity_logs" ADD COLUMN "chainSeq" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "security_audit_log" ADD COLUMN "chain_seq" bigserial NOT NULL;