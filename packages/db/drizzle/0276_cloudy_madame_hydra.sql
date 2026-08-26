CREATE TABLE "published_app_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"publishedAppId" text NOT NULL,
	"userId" text NOT NULL,
	"stripeSubscriptionId" text NOT NULL,
	"stripePriceId" text NOT NULL,
	"guestPreset" text NOT NULL,
	"status" text NOT NULL,
	"stripeEventCreated" timestamp with time zone,
	"currentPeriodStart" timestamp with time zone NOT NULL,
	"currentPeriodEnd" timestamp with time zone NOT NULL,
	"cancelAtPeriodEnd" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "published_app_subscriptions_publishedAppId_unique" UNIQUE("publishedAppId"),
	CONSTRAINT "published_app_subscriptions_stripeSubscriptionId_unique" UNIQUE("stripeSubscriptionId"),
	CONSTRAINT "published_app_subscriptions_status_nonempty" CHECK (length("published_app_subscriptions"."status") > 0),
	CONSTRAINT "published_app_subscriptions_period_ordered" CHECK ("published_app_subscriptions"."currentPeriodEnd" >= "published_app_subscriptions"."currentPeriodStart")
);
--> statement-breakpoint
ALTER TABLE "published_apps" DROP CONSTRAINT "published_apps_guest_preset_allowed";--> statement-breakpoint
ALTER TABLE "published_app_subscriptions" ADD CONSTRAINT "published_app_subscriptions_publishedAppId_published_apps_id_fk" FOREIGN KEY ("publishedAppId") REFERENCES "public"."published_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_app_subscriptions" ADD CONSTRAINT "published_app_subscriptions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "published_app_subscriptions_user_idx" ON "published_app_subscriptions" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "published_app_subscriptions_stripe_subscription_idx" ON "published_app_subscriptions" USING btree ("stripeSubscriptionId");--> statement-breakpoint
ALTER TABLE "published_apps" ADD CONSTRAINT "published_apps_metered_guest_preset" CHECK ("published_apps"."tier" <> 'metered' OR "published_apps"."guestPreset" = 'shared-cpu-1x-512');--> statement-breakpoint
ALTER TABLE "published_apps" ADD CONSTRAINT "published_apps_guest_preset_allowed" CHECK ("published_apps"."guestPreset" IN ('shared-cpu-1x-512', 'shared-cpu-1x-1024', 'shared-cpu-2x-2048', 'shared-cpu-4x-4096'));