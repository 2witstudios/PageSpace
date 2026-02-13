ALTER TYPE "PageType" ADD VALUE 'CODE';--> statement-breakpoint
ALTER TYPE "display_preference_type" ADD VALUE 'DEFAULT_MARKDOWN_MODE';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"device_type" text,
	"transports" text[],
	"backed_up" boolean DEFAULT false,
	"name" text,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "passkeys_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_provider_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"provider" text NOT NULL,
	"consentedAt" timestamp DEFAULT now() NOT NULL,
	"revokedAt" timestamp,
	CONSTRAINT "user_provider_consent_unique" UNIQUE("userId","provider")
);
--> statement-breakpoint
DROP TABLE "drive_invitations";--> statement-breakpoint
ALTER TABLE "file_pages" DROP CONSTRAINT "file_pages_page_id_key";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "currentAiModel" SET DEFAULT 'glm-4.7';--> statement-breakpoint
ALTER TABLE "calendar_events" ALTER COLUMN "googleSyncReadOnly" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "google_calendar_connections" ALTER COLUMN "markAsReadOnly" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "admin_role_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "contentMode" text DEFAULT 'html' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD COLUMN "isActive" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD COLUMN "aiMeta" jsonb;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "google_calendar_connections" ADD COLUMN "webhookChannels" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_provider_consents" ADD CONSTRAINT "ai_provider_consents_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkeys_user_id_idx" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkeys_credential_id_idx" ON "passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_usage_expires_at" ON "ai_usage_logs" USING btree ("expires_at");