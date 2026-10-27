CREATE TABLE IF NOT EXISTS "incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"severity" text NOT NULL,
	"status" text DEFAULT 'detected' NOT NULL,
	"category" text,
	"detectedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"reportedBy" text,
	"affectedUserCount" integer,
	"affectedScope" jsonb,
	"riskLevel" text,
	"requiresAuthorityNotification" boolean,
	"authorityNotificationDeadline" timestamp with time zone,
	"authorityNotifiedAt" timestamp with time zone,
	"requiresSubjectNotification" boolean,
	"subjectsNotifiedAt" timestamp with time zone,
	"metadata" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"closedAt" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "dataCategory" text;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "legalBasis" text;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "retentionPolicy" text;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "recipients" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incidents" ADD CONSTRAINT "incidents_reportedBy_users_id_fk" FOREIGN KEY ("reportedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_incidents_status" ON "incidents" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_incidents_detected_at" ON "incidents" USING btree ("detectedAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_incidents_authority_deadline" ON "incidents" USING btree ("authorityNotificationDeadline");