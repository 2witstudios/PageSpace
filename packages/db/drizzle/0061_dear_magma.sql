DO $$ BEGIN
 CREATE TYPE "public"."pulse_summary_type" AS ENUM('scheduled', 'on_demand', 'welcome');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pulse_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"summary" text NOT NULL,
	"greeting" text,
	"type" "pulse_summary_type" DEFAULT 'scheduled' NOT NULL,
	"contextData" jsonb,
	"aiProvider" text,
	"aiModel" text,
	"periodStart" timestamp NOT NULL,
	"periodEnd" timestamp NOT NULL,
	"generatedAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pulse_summaries" ADD CONSTRAINT "pulse_summaries_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pulse_summaries_user_id" ON "pulse_summaries" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pulse_summaries_generated_at" ON "pulse_summaries" USING btree ("generatedAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pulse_summaries_expires_at" ON "pulse_summaries" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pulse_summaries_user_generated" ON "pulse_summaries" USING btree ("userId","generatedAt");
