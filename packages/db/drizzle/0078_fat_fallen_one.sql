CREATE TABLE IF NOT EXISTS "ai_provider_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"provider" text NOT NULL,
	"consentedAt" timestamp DEFAULT now() NOT NULL,
	"revokedAt" timestamp,
	CONSTRAINT "user_provider_consent_unique" UNIQUE("userId","provider")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_provider_consents" ADD CONSTRAINT "ai_provider_consents_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
