ALTER TABLE "org_audit_outbox" ADD COLUMN "discardIfUnreleased" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "org_audit_outbox" ADD COLUMN "deadLetteredAt" timestamp;