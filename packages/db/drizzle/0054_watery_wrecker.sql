CREATE TABLE IF NOT EXISTS "user_hotkey_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"hotkeyId" text NOT NULL,
	"binding" text NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_hotkey_preferences" ADD CONSTRAINT "user_hotkey_preferences_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_hotkey_preferences_user_hotkey_idx" ON "user_hotkey_preferences" USING btree ("userId","hotkeyId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_hotkey_preferences_user_idx" ON "user_hotkey_preferences" USING btree ("userId");