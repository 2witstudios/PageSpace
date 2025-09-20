DO $$ BEGIN
 CREATE TYPE "public"."ConnectionStatus" AS ENUM('PENDING', 'ACCEPTED', 'BLOCKED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TYPE "PageType" ADD VALUE 'FILE';--> statement-breakpoint
ALTER TYPE "NotificationType" ADD VALUE 'CONNECTION_REQUEST';--> statement-breakpoint
ALTER TYPE "NotificationType" ADD VALUE 'CONNECTION_ACCEPTED';--> statement-breakpoint
ALTER TYPE "NotificationType" ADD VALUE 'CONNECTION_REJECTED';--> statement-breakpoint
ALTER TYPE "NotificationType" ADD VALUE 'NEW_DIRECT_MESSAGE';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "storage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"pageId" text,
	"eventType" text NOT NULL,
	"sizeDelta" real NOT NULL,
	"totalSizeAfter" real NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"conversationId" text,
	"messageId" text,
	"parentTaskId" text,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"position" integer DEFAULT 1,
	"metadata" jsonb,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
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
CREATE TABLE IF NOT EXISTS "ai_usage_daily" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"date" date NOT NULL,
	"providerType" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_daily_user_date_provider_unique" UNIQUE("userId","date","providerType")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"processedAt" timestamp DEFAULT now() NOT NULL,
	"error" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"stripeSubscriptionId" text NOT NULL,
	"stripePriceId" text NOT NULL,
	"status" text NOT NULL,
	"currentPeriodStart" timestamp NOT NULL,
	"currentPeriodEnd" timestamp NOT NULL,
	"cancelAtPeriodEnd" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_stripeSubscriptionId_unique" UNIQUE("stripeSubscriptionId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_profiles" DROP CONSTRAINT "user_profiles_username_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "user_profiles_username_idx";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "currentAiModel" SET DEFAULT 'gemini-2.5-flash';--> statement-breakpoint
ALTER TABLE "user_profiles" ALTER COLUMN "username" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "storageUsedBytes" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "activeUploads" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "lastStorageCalculated" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripeCustomerId" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "subscriptionTier" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "createdAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "updatedAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "messageType" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "drives" ADD COLUMN "isTrashed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "drives" ADD COLUMN "trashedAt" timestamp;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "systemPrompt" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "enabledTools" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "fileSize" real;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "mimeType" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "originalFileName" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "filePath" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "fileMetadata" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "processingStatus" text DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "processingError" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "processedAt" timestamp;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "extractionMethod" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "extractionMetadata" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "contentHash" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "messageType" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "storage_events" ADD CONSTRAINT "storage_events_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "storage_events" ADD CONSTRAINT "storage_events_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
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
 ALTER TABLE "ai_usage_daily" ADD CONSTRAINT "ai_usage_daily_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_events_user_id_idx" ON "storage_events" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_events_created_at_idx" ON "storage_events" USING btree ("createdAt");--> statement-breakpoint
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
CREATE INDEX IF NOT EXISTS "ai_usage_daily_user_id_idx" ON "ai_usage_daily" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_usage_daily_date_idx" ON "ai_usage_daily" USING btree ("date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_events_type_idx" ON "stripe_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_events_processed_at_idx" ON "stripe_events" USING btree ("processedAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_user_id_idx" ON "subscriptions" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_stripe_subscription_id_idx" ON "subscriptions" USING btree ("stripeSubscriptionId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_submissions_email_idx" ON "contact_submissions" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_submissions_created_at_idx" ON "contact_submissions" USING btree ("createdAt");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_stripeCustomerId_unique" UNIQUE("stripeCustomerId");