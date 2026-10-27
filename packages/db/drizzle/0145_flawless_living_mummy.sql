CREATE TABLE IF NOT EXISTS "sandbox_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"sessionKey" text NOT NULL,
	"conversationId" text NOT NULL,
	"driveId" text,
	"tenantId" text,
	"userId" text NOT NULL,
	"sandboxId" text NOT NULL,
	"lastActiveAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "sandbox_sessions_sessionKey_unique" UNIQUE("sessionKey")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sandbox_sessions" ADD CONSTRAINT "sandbox_sessions_conversationId_conversations_id_fk" FOREIGN KEY ("conversationId") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sandbox_sessions" ADD CONSTRAINT "sandbox_sessions_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sandbox_sessions" ADD CONSTRAINT "sandbox_sessions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sandbox_sessions_conversation_id_idx" ON "sandbox_sessions" USING btree ("conversationId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sandbox_sessions_last_active_at_idx" ON "sandbox_sessions" USING btree ("lastActiveAt");