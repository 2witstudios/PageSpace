CREATE TABLE IF NOT EXISTS "ai_processing_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"policyVersion" integer NOT NULL,
	"consentedAt" timestamp DEFAULT now() NOT NULL,
	"revokedAt" timestamp
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ageVerifiedAt" timestamp;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_processing_consents" ADD CONSTRAINT "ai_processing_consents_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_processing_consents_user_id_idx" ON "ai_processing_consents" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_processing_consents_active_user_unique" ON "ai_processing_consents" USING btree ("userId") WHERE "ai_processing_consents"."revokedAt" IS NULL;