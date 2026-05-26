CREATE TABLE "message_drafts" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL,
  "contextKey" text NOT NULL,
  "content" text NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  "expiresAt" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "message_drafts_user_context_key" ON "message_drafts" USING btree ("userId","contextKey");
--> statement-breakpoint
CREATE INDEX "message_drafts_expires_at_idx" ON "message_drafts" USING btree ("expiresAt");
