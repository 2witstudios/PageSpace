DO $$ BEGIN
 CREATE TYPE "public"."ConnectionStatus" AS ENUM('PENDING', 'ACCEPTED', 'BLOCKED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."DmPrivacy" AS ENUM('connections_only', 'anyone');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user1Id" text NOT NULL,
	"user2Id" text NOT NULL,
	"status" "ConnectionStatus" DEFAULT 'PENDING' NOT NULL,
	"requestedBy" text NOT NULL,
	"requestMessage" text,
	"requestedAt" timestamp DEFAULT now() NOT NULL,
	"acceptedAt" timestamp,
	"blockedBy" text,
	"blockedAt" timestamp,
	CONSTRAINT "connections_user_pair_key" UNIQUE("user1Id","user2Id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "direct_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversationId" text NOT NULL,
	"senderId" text NOT NULL,
	"content" text NOT NULL,
	"isRead" boolean DEFAULT false NOT NULL,
	"readAt" timestamp,
	"isEdited" boolean DEFAULT false NOT NULL,
	"editedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dm_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"participant1Id" text NOT NULL,
	"participant2Id" text NOT NULL,
	"lastMessageAt" timestamp,
	"lastMessagePreview" text,
	"participant1LastRead" timestamp,
	"participant2LastRead" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "dm_conversations_participant_pair_key" UNIQUE("participant1Id","participant2Id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_handles" (
	"userId" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"discriminator" integer NOT NULL,
	"dmPrivacy" "DmPrivacy" DEFAULT 'connections_only' NOT NULL,
	"showInSearch" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "user_handles_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connections" ADD CONSTRAINT "connections_user1Id_users_id_fk" FOREIGN KEY ("user1Id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connections" ADD CONSTRAINT "connections_user2Id_users_id_fk" FOREIGN KEY ("user2Id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connections" ADD CONSTRAINT "connections_requestedBy_users_id_fk" FOREIGN KEY ("requestedBy") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connections" ADD CONSTRAINT "connections_blockedBy_users_id_fk" FOREIGN KEY ("blockedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_conversationId_dm_conversations_id_fk" FOREIGN KEY ("conversationId") REFERENCES "public"."dm_conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_senderId_users_id_fk" FOREIGN KEY ("senderId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dm_conversations" ADD CONSTRAINT "dm_conversations_participant1Id_users_id_fk" FOREIGN KEY ("participant1Id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dm_conversations" ADD CONSTRAINT "dm_conversations_participant2Id_users_id_fk" FOREIGN KEY ("participant2Id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_handles" ADD CONSTRAINT "user_handles_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connections_user1_id_idx" ON "connections" USING btree ("user1Id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connections_user2_id_idx" ON "connections" USING btree ("user2Id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connections_status_idx" ON "connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connections_user1_status_idx" ON "connections" USING btree ("user1Id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connections_user2_status_idx" ON "connections" USING btree ("user2Id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "direct_messages_conversation_id_idx" ON "direct_messages" USING btree ("conversationId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "direct_messages_sender_id_idx" ON "direct_messages" USING btree ("senderId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "direct_messages_created_at_idx" ON "direct_messages" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "direct_messages_conversation_created_idx" ON "direct_messages" USING btree ("conversationId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "direct_messages_conversation_is_read_idx" ON "direct_messages" USING btree ("conversationId","isRead");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_conversations_participant1_id_idx" ON "dm_conversations" USING btree ("participant1Id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_conversations_participant2_id_idx" ON "dm_conversations" USING btree ("participant2Id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_conversations_last_message_at_idx" ON "dm_conversations" USING btree ("lastMessageAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_conversations_participant1_last_message_idx" ON "dm_conversations" USING btree ("participant1Id","lastMessageAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_conversations_participant2_last_message_idx" ON "dm_conversations" USING btree ("participant2Id","lastMessageAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_handles_handle_idx" ON "user_handles" USING btree ("handle");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_handles_discriminator_idx" ON "user_handles" USING btree ("discriminator");