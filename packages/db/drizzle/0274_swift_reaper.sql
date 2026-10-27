CREATE TABLE "published_app_machine_events" (
	"id" text PRIMARY KEY NOT NULL,
	"publishedAppId" text NOT NULL,
	"flyAppName" text NOT NULL,
	"machineId" text NOT NULL,
	"origin" text NOT NULL,
	"action" text NOT NULL,
	"flyEventId" text,
	"flyEventType" text,
	"flyEventStatus" text,
	"occurredAt" timestamp with time zone NOT NULL,
	"recordedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "published_app_machine_events_origin_allowed" CHECK ("published_app_machine_events"."origin" IN ('orchestrator', 'fly')),
	CONSTRAINT "published_app_machine_events_action_allowed" CHECK ("published_app_machine_events"."action" IN ('start', 'stop')),
	CONSTRAINT "published_app_machine_events_fly_event_id_coherent" CHECK (("published_app_machine_events"."origin" = 'fly') = ("published_app_machine_events"."flyEventId" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "published_apps" ADD COLUMN "imageSizeMeasuredAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "published_apps" ADD COLUMN "awakeBilledThrough" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "published_apps" ADD COLUMN "awakeHoldId" text;--> statement-breakpoint
ALTER TABLE "published_apps" ADD COLUMN "storageLastBilledAt" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "published_app_machine_events" ADD CONSTRAINT "published_app_machine_events_publishedAppId_published_apps_id_fk" FOREIGN KEY ("publishedAppId") REFERENCES "public"."published_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "published_app_machine_events_app_idx" ON "published_app_machine_events" USING btree ("publishedAppId","occurredAt");--> statement-breakpoint
CREATE UNIQUE INDEX "published_app_machine_events_fly_event_unique" ON "published_app_machine_events" USING btree ("machineId","flyEventId") WHERE "flyEventId" IS NOT NULL;--> statement-breakpoint
-- Hand-added backfill (the only hand-added content in this file). Postgres
-- validates a CHECK against every existing row the moment it is added, and a row
-- built before this migration already carries an `imageSizeBytes` while the column
-- beside it is necessarily NULL — so without this UPDATE the constraint below
-- fails on any deployment that has ever built a published app, and the migration
-- one-shot blocks the whole release. Dated from `updatedAt`, the closest record
-- this schema keeps of when that size was written; the storage meter reads the
-- age as measurement staleness, which for a legacy size is exactly true.
-- It cannot be a separate migration: `runMigrations` applies every pending entry
-- in ONE invocation, so a backfill registered after this file would still run
-- after the constraint it exists to satisfy.
UPDATE "published_apps" SET "imageSizeMeasuredAt" = "updatedAt" WHERE "imageSizeBytes" IS NOT NULL AND "imageSizeMeasuredAt" IS NULL;--> statement-breakpoint
ALTER TABLE "published_apps" ADD CONSTRAINT "published_apps_image_size_measured_coherent" CHECK (("published_apps"."imageSizeBytes" IS NULL) = ("published_apps"."imageSizeMeasuredAt" IS NULL));--> statement-breakpoint
ALTER TABLE "published_apps" ADD CONSTRAINT "published_apps_awake_window_needs_wake" CHECK ("published_apps"."awakeBilledThrough" IS NULL OR "published_apps"."lastWakeAt" IS NOT NULL);