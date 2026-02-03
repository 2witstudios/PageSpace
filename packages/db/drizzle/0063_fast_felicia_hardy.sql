CREATE TABLE IF NOT EXISTS "user_personalization" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"bio" text,
	"writingStyle" text,
	"rules" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_personalization" ADD CONSTRAINT "user_personalization_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_personalization_user_idx" ON "user_personalization" USING btree ("userId");