CREATE INDEX IF NOT EXISTS "pending_invites_email_idx" ON "pending_invites" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_page_invites_email_idx" ON "pending_page_invites" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_connection_invites_email_idx" ON "pending_connection_invites" USING btree ("email");