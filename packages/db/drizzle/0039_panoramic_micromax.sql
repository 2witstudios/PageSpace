CREATE TABLE IF NOT EXISTS "user_integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"integrationId" text NOT NULL,
	"name" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"encryptedApiKey" text,
	"config" jsonb,
	"enabledTools" jsonb,
	"lastValidatedAt" timestamp,
	"validationStatus" text,
	"validationMessage" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_integration_unique" UNIQUE("userId","integrationId")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_integrations" ADD CONSTRAINT "user_integrations_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_integrations_user_id_idx" ON "user_integrations" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_integrations_integration_id_idx" ON "user_integrations" USING btree ("integrationId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_integrations_enabled_idx" ON "user_integrations" USING btree ("userId","enabled");