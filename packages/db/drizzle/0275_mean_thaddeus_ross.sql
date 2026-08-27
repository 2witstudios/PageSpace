ALTER TABLE "published_apps" ADD COLUMN "lastHitAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "published_apps" ADD COLUMN "awakeSecondsDay" date;--> statement-breakpoint
ALTER TABLE "published_apps" ADD COLUMN "awakeSecondsToday" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "published_apps_idle_idx" ON "published_apps" USING btree ("status","lastHitAt");--> statement-breakpoint
ALTER TABLE "published_apps" ADD CONSTRAINT "published_apps_awake_seconds_today_nonneg" CHECK ("published_apps"."awakeSecondsToday" >= 0);--> statement-breakpoint
ALTER TABLE "published_apps" ADD CONSTRAINT "published_apps_awake_counter_needs_day" CHECK ("published_apps"."awakeSecondsDay" IS NOT NULL OR "published_apps"."awakeSecondsToday" = 0);