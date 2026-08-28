CREATE TABLE "app_hosting_stripe_reclaims" (
	"stripeSubscriptionId" text PRIMARY KEY NOT NULL,
	"publishedAppId" text,
	"recordedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lastAttemptAt" timestamp with time zone,
	"lastError" text,
	CONSTRAINT "app_hosting_stripe_reclaims_attempts_nonneg" CHECK ("app_hosting_stripe_reclaims"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "custom_domains" ADD COLUMN "published_app_id" text;--> statement-breakpoint
CREATE INDEX "app_hosting_stripe_reclaims_recorded_at_idx" ON "app_hosting_stripe_reclaims" USING btree ("recordedAt");--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_published_app_id_published_apps_id_fk" FOREIGN KEY ("published_app_id") REFERENCES "public"."published_apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_domains_published_app_id_idx" ON "custom_domains" USING btree ("published_app_id");