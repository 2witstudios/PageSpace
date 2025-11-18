DO $$ BEGIN
 CREATE TYPE "public"."PlatformType" AS ENUM('web', 'desktop', 'ios', 'android');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"token" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"lastUsedAt" timestamp,
	"deviceId" text NOT NULL,
	"platform" "PlatformType" NOT NULL,
	"deviceName" text,
	"userAgent" text,
	"ipAddress" text,
	"lastIpAddress" text,
	"location" text,
	"trustScore" real DEFAULT 1 NOT NULL,
	"suspiciousActivityCount" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"revokedAt" timestamp,
	"revokedReason" text,
	CONSTRAINT "device_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "expiresAt" timestamp;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "lastUsedAt" timestamp;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "platform" "PlatformType";--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "deviceTokenId" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_tokens_user_id_idx" ON "device_tokens" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_tokens_token_idx" ON "device_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_tokens_device_id_idx" ON "device_tokens" USING btree ("deviceId");