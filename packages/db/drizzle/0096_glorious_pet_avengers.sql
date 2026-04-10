CREATE TABLE IF NOT EXISTS "siem_delivery_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"lastDeliveredId" text,
	"lastDeliveredAt" timestamp,
	"lastError" text,
	"lastErrorAt" timestamp,
	"deliveryCount" integer DEFAULT 0 NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
