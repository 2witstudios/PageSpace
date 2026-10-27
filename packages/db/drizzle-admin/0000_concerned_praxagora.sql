CREATE TABLE IF NOT EXISTS "security_audit_log" (
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
	"chain_seq" bigserial NOT NULL,
	"previous_hash" text NOT NULL,
	"event_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "siem_delivery_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"lastDeliveredId" text,
	"lastDeliveredAt" timestamp,
	"lastError" text,
	"lastErrorAt" timestamp,
	"deliveryCount" integer DEFAULT 0 NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "siem_delivery_receipts" (
	"receiptId" text PRIMARY KEY NOT NULL,
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
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_timestamp" ON "security_audit_log" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_user_timestamp" ON "security_audit_log" USING btree ("user_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_event_type" ON "security_audit_log" USING btree ("event_type","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_resource" ON "security_audit_log" USING btree ("resource_type","resource_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_ip" ON "security_audit_log" USING btree ("ip_address","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_ip_bidx" ON "security_audit_log" USING btree ("ip_bidx","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_event_hash" ON "security_audit_log" USING btree ("event_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_chain_seq" ON "security_audit_log" USING btree ("chain_seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_risk_score" ON "security_audit_log" USING btree ("risk_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_session" ON "security_audit_log" USING btree ("session_id","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "siem_delivery_receipts_delivery_source_unique" ON "siem_delivery_receipts" USING btree ("deliveryId","source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_siem_receipts_delivery_id" ON "siem_delivery_receipts" USING btree ("deliveryId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_siem_receipts_first_entry" ON "siem_delivery_receipts" USING btree ("firstEntryId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_siem_receipts_last_entry" ON "siem_delivery_receipts" USING btree ("lastEntryId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_siem_receipts_delivered_at" ON "siem_delivery_receipts" USING btree ("deliveredAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_siem_receipts_source_range" ON "siem_delivery_receipts" USING btree ("source","firstEntryTimestamp","lastEntryTimestamp");