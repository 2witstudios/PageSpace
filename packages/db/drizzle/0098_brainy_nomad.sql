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
CREATE UNIQUE INDEX IF NOT EXISTS "siem_delivery_receipts_delivery_source_unique" ON "siem_delivery_receipts" USING btree ("deliveryId","source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_siem_receipts_delivery_id" ON "siem_delivery_receipts" USING btree ("deliveryId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_siem_receipts_first_entry" ON "siem_delivery_receipts" USING btree ("firstEntryId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_siem_receipts_last_entry" ON "siem_delivery_receipts" USING btree ("lastEntryId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_siem_receipts_delivered_at" ON "siem_delivery_receipts" USING btree ("deliveredAt");