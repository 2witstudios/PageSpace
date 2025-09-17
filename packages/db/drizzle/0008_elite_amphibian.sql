CREATE TABLE IF NOT EXISTS "storage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"pageId" text,
	"eventType" text NOT NULL,
	"sizeDelta" real NOT NULL,
	"totalSizeAfter" real NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "storageUsedBytes" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "storageQuotaBytes" real DEFAULT 524288000 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "storageTier" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "activeUploads" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "lastStorageCalculated" timestamp;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "storage_events" ADD CONSTRAINT "storage_events_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "storage_events" ADD CONSTRAINT "storage_events_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_events_user_id_idx" ON "storage_events" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_events_created_at_idx" ON "storage_events" USING btree ("createdAt");