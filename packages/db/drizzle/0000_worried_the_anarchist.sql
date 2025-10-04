DO $$ BEGIN
 CREATE TYPE "public"."AuthProvider" AS ENUM('email', 'google', 'both');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."UserRole" AS ENUM('user', 'admin');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."PageType" AS ENUM('FOLDER', 'DOCUMENT', 'CHANNEL', 'AI_CHAT', 'CANVAS', 'FILE', 'SHEET');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."PermissionAction" AS ENUM('VIEW', 'EDIT', 'SHARE', 'DELETE');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."SubjectType" AS ENUM('USER');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."InvitationStatus" AS ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."MemberRole" AS ENUM('OWNER', 'ADMIN', 'MEMBER');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."NotificationType" AS ENUM('PERMISSION_GRANTED', 'PERMISSION_REVOKED', 'PERMISSION_UPDATED', 'PAGE_SHARED', 'DRIVE_INVITED', 'DRIVE_JOINED', 'DRIVE_ROLE_CHANGED', 'CONNECTION_REQUEST', 'CONNECTION_ACCEPTED', 'CONNECTION_REJECTED', 'NEW_DIRECT_MESSAGE', 'EMAIL_VERIFICATION_REQUIRED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."http_method" AS ENUM('GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."log_level" AS ENUM('trace', 'debug', 'info', 'warn', 'error', 'fatal');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."ConnectionStatus" AS ENUM('PENDING', 'ACCEPTED', 'BLOCKED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"token" text NOT NULL,
	"name" text NOT NULL,
	"lastUsed" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"revokedAt" timestamp,
	CONSTRAINT "mcp_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"token" text NOT NULL,
	"device" text,
	"ip" text,
	"userAgent" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" timestamp,
	"image" text,
	"password" text,
	"googleId" text,
	"provider" "AuthProvider" DEFAULT 'email' NOT NULL,
	"tokenVersion" integer DEFAULT 0 NOT NULL,
	"role" "UserRole" DEFAULT 'user' NOT NULL,
	"currentAiProvider" text DEFAULT 'pagespace' NOT NULL,
	"currentAiModel" text DEFAULT 'GLM-4.5-air' NOT NULL,
	"storageUsedBytes" real DEFAULT 0 NOT NULL,
	"activeUploads" integer DEFAULT 0 NOT NULL,
	"lastStorageCalculated" timestamp,
	"stripeCustomerId" text,
	"subscriptionTier" text DEFAULT 'free' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_googleId_unique" UNIQUE("googleId"),
	CONSTRAINT "users_stripeCustomerId_unique" UNIQUE("stripeCustomerId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"token" text NOT NULL,
	"type" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"usedAt" timestamp,
	CONSTRAINT "verification_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"pageId" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"toolCalls" jsonb,
	"toolResults" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"editedAt" timestamp,
	"userId" text,
	"agentRole" text DEFAULT 'PARTNER' NOT NULL,
	"messageType" text DEFAULT 'standard' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drives" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"ownerId" text NOT NULL,
	"isTrashed" boolean DEFAULT false NOT NULL,
	"trashedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "favorites" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"pageId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mentions" (
	"id" text PRIMARY KEY NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"sourcePageId" text NOT NULL,
	"targetPageId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_tags" (
	"pageId" text NOT NULL,
	"tagId" text NOT NULL,
	CONSTRAINT "page_tags_pageId_tagId_pk" PRIMARY KEY("pageId","tagId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pages" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"type" "PageType" NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"position" real NOT NULL,
	"isTrashed" boolean DEFAULT false NOT NULL,
	"aiProvider" text,
	"aiModel" text,
	"systemPrompt" text,
	"enabledTools" jsonb,
	"fileSize" real,
	"mimeType" text,
	"originalFileName" text,
	"filePath" text,
	"fileMetadata" jsonb,
	"processingStatus" text DEFAULT 'pending',
	"processingError" text,
	"processedAt" timestamp,
	"extractionMethod" text,
	"extractionMetadata" jsonb,
	"contentHash" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	"trashedAt" timestamp,
	"driveId" text NOT NULL,
	"parentId" text,
	"originalParentId" text
);
--> statement-breakpoint
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
CREATE TABLE IF NOT EXISTS "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	CONSTRAINT "tags_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"action" "PermissionAction" NOT NULL,
	"subjectType" "SubjectType" NOT NULL,
	"subjectId" text NOT NULL,
	"pageId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drive_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"driveId" text NOT NULL,
	"email" text NOT NULL,
	"userId" text,
	"invitedBy" text NOT NULL,
	"status" "InvitationStatus" DEFAULT 'PENDING' NOT NULL,
	"token" text NOT NULL,
	"message" text,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"respondedAt" timestamp,
	CONSTRAINT "drive_invitations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drive_members" (
	"id" text PRIMARY KEY NOT NULL,
	"driveId" text NOT NULL,
	"userId" text NOT NULL,
	"role" "MemberRole" DEFAULT 'MEMBER' NOT NULL,
	"invitedBy" text,
	"invitedAt" timestamp DEFAULT now() NOT NULL,
	"acceptedAt" timestamp,
	"lastAccessedAt" timestamp,
	CONSTRAINT "drive_members_drive_user_key" UNIQUE("driveId","userId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"pageId" text NOT NULL,
	"userId" text NOT NULL,
	"canView" boolean DEFAULT false NOT NULL,
	"canEdit" boolean DEFAULT false NOT NULL,
	"canShare" boolean DEFAULT false NOT NULL,
	"canDelete" boolean DEFAULT false NOT NULL,
	"grantedBy" text,
	"grantedAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp,
	"note" text,
	CONSTRAINT "page_permissions_page_user_key" UNIQUE("pageId","userId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_profiles" (
	"userId" text PRIMARY KEY NOT NULL,
	"username" text,
	"displayName" text NOT NULL,
	"bio" text,
	"avatarUrl" text,
	"isPublic" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"pageId" text NOT NULL,
	"userId" text NOT NULL
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
CREATE TABLE IF NOT EXISTS "user_ai_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"provider" text NOT NULL,
	"encryptedApiKey" text,
	"baseUrl" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_provider_unique" UNIQUE("userId","provider")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_dashboards" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "user_dashboards_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"title" text,
	"type" text NOT NULL,
	"contextId" text,
	"lastMessageAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversationId" text NOT NULL,
	"userId" text NOT NULL,
	"role" text NOT NULL,
	"messageType" text DEFAULT 'standard' NOT NULL,
	"content" text NOT NULL,
	"toolCalls" jsonb,
	"toolResults" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"agentRole" text DEFAULT 'PARTNER' NOT NULL,
	"editedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"type" "NotificationType" NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb,
	"isRead" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"readAt" timestamp,
	"pageId" text,
	"driveId" text,
	"triggeredByUserId" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_notification_log" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"notificationId" text,
	"notificationType" "NotificationType" NOT NULL,
	"recipientEmail" text NOT NULL,
	"success" boolean NOT NULL,
	"errorMessage" text,
	"sentAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_notification_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"notificationType" "NotificationType" NOT NULL,
	"emailEnabled" boolean DEFAULT true NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_usage_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"cost" real,
	"currency" text DEFAULT 'USD',
	"duration" integer,
	"streaming_duration" integer,
	"conversation_id" text,
	"message_id" text,
	"page_id" text,
	"drive_id" text,
	"prompt" text,
	"completion" text,
	"success" boolean DEFAULT true,
	"error" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alert_history" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"threshold" real,
	"actual_value" real,
	"notified" boolean DEFAULT false,
	"notified_at" timestamp,
	"notification_channel" text,
	"acknowledged" boolean DEFAULT false,
	"acknowledged_at" timestamp,
	"acknowledged_by" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"endpoint" text NOT NULL,
	"method" "http_method" NOT NULL,
	"status_code" integer NOT NULL,
	"duration" integer NOT NULL,
	"request_size" integer,
	"response_size" integer,
	"user_id" text,
	"session_id" text,
	"ip" text,
	"user_agent" text,
	"error" text,
	"request_id" text,
	"cache_hit" boolean DEFAULT false,
	"cache_key" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daily_aggregates" (
	"id" text PRIMARY KEY NOT NULL,
	"date" timestamp NOT NULL,
	"category" text NOT NULL,
	"total_count" integer DEFAULT 0,
	"success_count" integer DEFAULT 0,
	"error_count" integer DEFAULT 0,
	"avg_duration" real,
	"min_duration" real,
	"max_duration" real,
	"p50_duration" real,
	"p95_duration" real,
	"p99_duration" real,
	"unique_users" integer DEFAULT 0,
	"unique_sessions" integer DEFAULT 0,
	"total_tokens" integer,
	"total_cost" real,
	"metadata" jsonb,
	"computed_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "error_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"user_id" text,
	"session_id" text,
	"request_id" text,
	"endpoint" text,
	"method" "http_method",
	"file" text,
	"line" integer,
	"column" integer,
	"ip" text,
	"user_agent" text,
	"metadata" jsonb,
	"resolved" boolean DEFAULT false,
	"resolved_at" timestamp,
	"resolved_by" text,
	"resolution" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "performance_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"metric" text NOT NULL,
	"value" real NOT NULL,
	"unit" text NOT NULL,
	"user_id" text,
	"session_id" text,
	"page_id" text,
	"drive_id" text,
	"metadata" jsonb,
	"cpu_usage" real,
	"memory_usage" real,
	"disk_usage" real
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"level" "log_level" NOT NULL,
	"message" text NOT NULL,
	"category" text,
	"user_id" text,
	"session_id" text,
	"request_id" text,
	"drive_id" text,
	"page_id" text,
	"endpoint" text,
	"method" "http_method",
	"ip" text,
	"user_agent" text,
	"error_name" text,
	"error_message" text,
	"error_stack" text,
	"duration" integer,
	"memory_used" integer,
	"memory_total" integer,
	"metadata" jsonb,
	"hostname" text,
	"pid" integer,
	"version" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text,
	"action" text NOT NULL,
	"resource" text,
	"resource_id" text,
	"drive_id" text,
	"page_id" text,
	"metadata" jsonb,
	"ip" text,
	"user_agent" text
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
CREATE TABLE IF NOT EXISTS "file_pages" (
	"fileId" text NOT NULL,
	"pageId" text NOT NULL,
	"linkedBy" text,
	"linkedAt" timestamp DEFAULT now() NOT NULL,
	"linkSource" text,
	CONSTRAINT "file_pages_fileId_pageId_pk" PRIMARY KEY("fileId","pageId"),
	CONSTRAINT "file_pages_page_id_key" UNIQUE("pageId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "files" (
	"id" text PRIMARY KEY NOT NULL,
	"driveId" text NOT NULL,
	"sizeBytes" bigint NOT NULL,
	"mimeType" text,
	"storagePath" text,
	"checksumVersion" integer DEFAULT 1 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"createdBy" text,
	"lastAccessedAt" timestamp
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drives" ADD CONSTRAINT "drives_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "favorites" ADD CONSTRAINT "favorites_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "favorites" ADD CONSTRAINT "favorites_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mentions" ADD CONSTRAINT "mentions_sourcePageId_pages_id_fk" FOREIGN KEY ("sourcePageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mentions" ADD CONSTRAINT "mentions_targetPageId_pages_id_fk" FOREIGN KEY ("targetPageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_tags" ADD CONSTRAINT "page_tags_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_tags" ADD CONSTRAINT "page_tags_tagId_tags_id_fk" FOREIGN KEY ("tagId") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pages" ADD CONSTRAINT "pages_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
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
 ALTER TABLE "permissions" ADD CONSTRAINT "permissions_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_invitations" ADD CONSTRAINT "drive_invitations_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_invitations" ADD CONSTRAINT "drive_invitations_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_invitations" ADD CONSTRAINT "drive_invitations_invitedBy_users_id_fk" FOREIGN KEY ("invitedBy") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_members" ADD CONSTRAINT "drive_members_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_members" ADD CONSTRAINT "drive_members_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_members" ADD CONSTRAINT "drive_members_invitedBy_users_id_fk" FOREIGN KEY ("invitedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_permissions" ADD CONSTRAINT "page_permissions_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_permissions" ADD CONSTRAINT "page_permissions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_permissions" ADD CONSTRAINT "page_permissions_grantedBy_users_id_fk" FOREIGN KEY ("grantedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
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
 ALTER TABLE "user_ai_settings" ADD CONSTRAINT "user_ai_settings_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_dashboards" ADD CONSTRAINT "user_dashboards_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversations" ADD CONSTRAINT "conversations_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_conversations_id_fk" FOREIGN KEY ("conversationId") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_triggeredByUserId_users_id_fk" FOREIGN KEY ("triggeredByUserId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_notification_log" ADD CONSTRAINT "email_notification_log_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_notification_preferences" ADD CONSTRAINT "email_notification_preferences_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
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
DO $$ BEGIN
 ALTER TABLE "file_pages" ADD CONSTRAINT "file_pages_fileId_files_id_fk" FOREIGN KEY ("fileId") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_pages" ADD CONSTRAINT "file_pages_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_pages" ADD CONSTRAINT "file_pages_linkedBy_users_id_fk" FOREIGN KEY ("linkedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "files" ADD CONSTRAINT "files_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "files" ADD CONSTRAINT "files_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_tokens_user_id_idx" ON "mcp_tokens" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_tokens_token_idx" ON "mcp_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_id_idx" ON "refresh_tokens" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_tokens_user_id_idx" ON "verification_tokens" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_tokens_token_idx" ON "verification_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_tokens_type_idx" ON "verification_tokens" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_page_id_idx" ON "chat_messages" USING btree ("pageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_user_id_idx" ON "chat_messages" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_page_id_is_active_created_at_idx" ON "chat_messages" USING btree ("pageId","isActive","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drives_owner_id_idx" ON "drives" USING btree ("ownerId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drives_owner_id_slug_key" ON "drives" USING btree ("ownerId","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "favorites_user_id_page_id_key" ON "favorites" USING btree ("userId","pageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mentions_source_page_id_target_page_id_key" ON "mentions" USING btree ("sourcePageId","targetPageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mentions_source_page_id_idx" ON "mentions" USING btree ("sourcePageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mentions_target_page_id_idx" ON "mentions" USING btree ("targetPageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_drive_id_idx" ON "pages" USING btree ("driveId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_parent_id_idx" ON "pages" USING btree ("parentId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_parent_id_position_idx" ON "pages" USING btree ("parentId","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_events_user_id_idx" ON "storage_events" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_events_created_at_idx" ON "storage_events" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permissions_page_id_idx" ON "permissions" USING btree ("pageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permissions_subject_id_subject_type_idx" ON "permissions" USING btree ("subjectId","subjectType");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permissions_page_id_subject_id_subject_type_idx" ON "permissions" USING btree ("pageId","subjectId","subjectType");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_invitations_drive_id_idx" ON "drive_invitations" USING btree ("driveId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_invitations_email_idx" ON "drive_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_invitations_status_idx" ON "drive_invitations" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_invitations_token_idx" ON "drive_invitations" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_members_drive_id_idx" ON "drive_members" USING btree ("driveId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_members_user_id_idx" ON "drive_members" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_members_role_idx" ON "drive_members" USING btree ("role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_permissions_page_id_idx" ON "page_permissions" USING btree ("pageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_permissions_user_id_idx" ON "page_permissions" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_permissions_expires_at_idx" ON "page_permissions" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_profiles_is_public_idx" ON "user_profiles" USING btree ("isPublic");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_messages_page_id_idx" ON "channel_messages" USING btree ("pageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_user_id_idx" ON "conversations" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_user_id_type_idx" ON "conversations" USING btree ("userId","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_user_id_last_message_at_idx" ON "conversations" USING btree ("userId","lastMessageAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_context_id_idx" ON "conversations" USING btree ("contextId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_conversation_id_idx" ON "messages" USING btree ("conversationId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_conversation_id_created_at_idx" ON "messages" USING btree ("conversationId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_user_id_idx" ON "messages" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_id_idx" ON "notifications" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_id_is_read_idx" ON "notifications" USING btree ("userId","isRead");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_created_at_idx" ON "notifications" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_type_idx" ON "notifications" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_notification_log_user_idx" ON "email_notification_log" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_notification_log_sent_at_idx" ON "email_notification_log" USING btree ("sentAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_notification_log_notification_id_idx" ON "email_notification_log" USING btree ("notificationId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_notification_preferences_user_type_idx" ON "email_notification_preferences" USING btree ("userId","notificationType");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_usage_timestamp" ON "ai_usage_logs" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_usage_user_id" ON "ai_usage_logs" USING btree ("user_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_usage_provider" ON "ai_usage_logs" USING btree ("provider","model","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_usage_cost" ON "ai_usage_logs" USING btree ("cost");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_usage_conversation" ON "ai_usage_logs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_alerts_timestamp" ON "alert_history" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_alerts_type" ON "alert_history" USING btree ("type","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_alerts_severity" ON "alert_history" USING btree ("severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_alerts_acknowledged" ON "alert_history" USING btree ("acknowledged");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_metrics_timestamp" ON "api_metrics" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_metrics_endpoint" ON "api_metrics" USING btree ("endpoint","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_metrics_user_id" ON "api_metrics" USING btree ("user_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_metrics_status" ON "api_metrics" USING btree ("status_code","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_metrics_duration" ON "api_metrics" USING btree ("duration");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_aggregates_date" ON "daily_aggregates" USING btree ("date","category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_aggregates_category" ON "daily_aggregates" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_errors_timestamp" ON "error_logs" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_errors_name" ON "error_logs" USING btree ("name","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_errors_user_id" ON "error_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_errors_resolved" ON "error_logs" USING btree ("resolved");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_errors_endpoint" ON "error_logs" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_performance_timestamp" ON "performance_metrics" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_performance_metric" ON "performance_metrics" USING btree ("metric","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_performance_value" ON "performance_metrics" USING btree ("value");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_performance_user_id" ON "performance_metrics" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_system_logs_timestamp" ON "system_logs" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_system_logs_level" ON "system_logs" USING btree ("level");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_system_logs_category" ON "system_logs" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_system_logs_user_id" ON "system_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_system_logs_request_id" ON "system_logs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_system_logs_error" ON "system_logs" USING btree ("error_name","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_activities_timestamp" ON "user_activities" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_activities_user_id" ON "user_activities" USING btree ("user_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_activities_action" ON "user_activities" USING btree ("action","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_activities_resource" ON "user_activities" USING btree ("resource","resource_id");--> statement-breakpoint
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
CREATE INDEX IF NOT EXISTS "direct_messages_unread_count_idx" ON "direct_messages" USING btree ("conversationId","senderId","isRead");--> statement-breakpoint
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
CREATE INDEX IF NOT EXISTS "file_pages_file_id_idx" ON "file_pages" USING btree ("fileId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_pages_page_id_idx" ON "file_pages" USING btree ("pageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_drive_id_idx" ON "files" USING btree ("driveId");