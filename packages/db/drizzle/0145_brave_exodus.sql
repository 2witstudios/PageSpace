CREATE TABLE IF NOT EXISTS "credit_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"estCents" integer NOT NULL,
	"aiUsageLogId" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_holds_user_idx" ON "credit_holds" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_holds_expires_idx" ON "credit_holds" USING btree ("expiresAt");