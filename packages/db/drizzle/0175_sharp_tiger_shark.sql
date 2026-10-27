ALTER TABLE "users" ADD COLUMN "emailBidx" text;--> statement-breakpoint
ALTER TABLE "security_audit_log" ADD COLUMN "ip_bidx" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_bidx_idx" ON "users" USING btree ("emailBidx");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_ip_bidx" ON "security_audit_log" USING btree ("ip_bidx","timestamp");