DO $$ BEGIN
 CREATE TYPE "public"."toast_notification_level" AS ENUM('all', 'mentions', 'off');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_toast_notification_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"level" "toast_notification_level" DEFAULT 'all' NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_toast_notification_preferences" ADD CONSTRAINT "user_toast_notification_preferences_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_toast_notification_preferences_user_idx" ON "user_toast_notification_preferences" USING btree ("userId");