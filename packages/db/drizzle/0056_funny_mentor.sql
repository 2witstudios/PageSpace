DO $$ BEGIN
 CREATE TYPE "public"."PushPlatformType" AS ENUM('ios', 'android', 'web');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_notification_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"token" text NOT NULL,
	"platform" "PushPlatformType" NOT NULL,
	"deviceId" text,
	"deviceName" text,
	"isActive" boolean DEFAULT true NOT NULL,
	"webPushSubscription" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"lastUsedAt" timestamp,
	"failedAttempts" text DEFAULT '0',
	"lastFailedAt" timestamp
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "push_notification_tokens" ADD CONSTRAINT "push_notification_tokens_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_notification_tokens_user_id_idx" ON "push_notification_tokens" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_notification_tokens_token_idx" ON "push_notification_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_notification_tokens_platform_idx" ON "push_notification_tokens" USING btree ("platform");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_notification_tokens_active_idx" ON "push_notification_tokens" USING btree ("userId","isActive");