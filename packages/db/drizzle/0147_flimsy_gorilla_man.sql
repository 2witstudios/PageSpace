CREATE TABLE IF NOT EXISTS "user_automation_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"pulseEnabled" boolean DEFAULT true NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD COLUMN "source" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_automation_preferences" ADD CONSTRAINT "user_automation_preferences_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_automation_preferences_user_idx" ON "user_automation_preferences" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_usage_user_source" ON "ai_usage_logs" USING btree ("user_id","source","timestamp");