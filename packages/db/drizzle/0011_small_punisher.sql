CREATE TABLE IF NOT EXISTS "ai_usage_daily" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"date" date NOT NULL,
	"providerType" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_daily_user_date_provider_unique" UNIQUE("userId","date","providerType")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"processedAt" timestamp DEFAULT now() NOT NULL,
	"error" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"stripeSubscriptionId" text NOT NULL,
	"stripePriceId" text NOT NULL,
	"status" text NOT NULL,
	"currentPeriodStart" timestamp NOT NULL,
	"currentPeriodEnd" timestamp NOT NULL,
	"cancelAtPeriodEnd" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_stripeSubscriptionId_unique" UNIQUE("stripeSubscriptionId")
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "currentAiModel" SET DEFAULT 'gemini-2.5-flash';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripeCustomerId" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "subscriptionTier" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "createdAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "updatedAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_usage_daily" ADD CONSTRAINT "ai_usage_daily_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_usage_daily_user_id_idx" ON "ai_usage_daily" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_usage_daily_date_idx" ON "ai_usage_daily" USING btree ("date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_events_type_idx" ON "stripe_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_events_processed_at_idx" ON "stripe_events" USING btree ("processedAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_user_id_idx" ON "subscriptions" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_stripe_subscription_id_idx" ON "subscriptions" USING btree ("stripeSubscriptionId");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_stripeCustomerId_unique" UNIQUE("stripeCustomerId");