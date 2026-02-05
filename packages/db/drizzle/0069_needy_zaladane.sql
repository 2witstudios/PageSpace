DO $$ BEGIN
 CREATE TYPE "public"."display_preference_type" AS ENUM('SHOW_TOKEN_COUNTS', 'SHOW_CODE_TOGGLE');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "display_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"preferenceType" "display_preference_type" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "display_preferences" ADD CONSTRAINT "display_preferences_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "display_preferences_user_type_idx" ON "display_preferences" USING btree ("userId","preferenceType");