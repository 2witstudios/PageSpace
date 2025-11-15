DO $$ BEGIN
 CREATE TYPE "public"."audit_action" AS ENUM('PAGE_CREATED', 'PAGE_UPDATED', 'PAGE_DELETED', 'PAGE_MOVED', 'PAGE_RESTORED', 'PAGE_DUPLICATED', 'PERMISSION_GRANTED', 'PERMISSION_REVOKED', 'PERMISSION_UPDATED', 'AI_TOOL_CALLED', 'AI_CONTENT_GENERATED', 'AI_CONVERSATION_STARTED', 'FILE_UPLOADED', 'FILE_DELETED', 'FILE_DOWNLOADED', 'FILE_MOVED', 'DRIVE_CREATED', 'DRIVE_UPDATED', 'DRIVE_DELETED', 'DRIVE_MEMBER_ADDED', 'DRIVE_MEMBER_REMOVED', 'DRIVE_MEMBER_ROLE_CHANGED', 'USER_LOGIN', 'USER_LOGOUT', 'USER_SIGNUP', 'USER_PASSWORD_CHANGED', 'SETTINGS_UPDATED', 'INTEGRATION_CONNECTED', 'INTEGRATION_DISCONNECTED', 'REALTIME_CONNECTED', 'REALTIME_DISCONNECTED', 'JOB_STARTED', 'JOB_COMPLETED', 'JOB_FAILED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."ai_agent_type" AS ENUM('ASSISTANT', 'EDITOR', 'RESEARCHER', 'CODER', 'ANALYST', 'WRITER', 'REVIEWER', 'CUSTOM');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."audit_action_type" AS ENUM('PAGE_CREATE', 'PAGE_UPDATE', 'PAGE_DELETE', 'PAGE_RESTORE', 'PAGE_MOVE', 'PAGE_RENAME', 'PAGE_DUPLICATE', 'PERMISSION_GRANT', 'PERMISSION_REVOKE', 'PERMISSION_UPDATE', 'DRIVE_CREATE', 'DRIVE_UPDATE', 'DRIVE_DELETE', 'DRIVE_RESTORE', 'MEMBER_ADD', 'MEMBER_REMOVE', 'MEMBER_UPDATE_ROLE', 'FILE_UPLOAD', 'FILE_DELETE', 'FILE_UPDATE', 'MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE', 'AI_EDIT', 'AI_GENERATE', 'AI_TOOL_CALL', 'AI_CONVERSATION', 'SETTINGS_UPDATE', 'EXPORT', 'IMPORT');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."audit_entity_type" AS ENUM('PAGE', 'DRIVE', 'PERMISSION', 'MEMBER', 'FILE', 'MESSAGE', 'SETTINGS', 'AI_OPERATION');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"action" "audit_action" NOT NULL,
	"category" text NOT NULL,
	"user_id" text,
	"user_email" text,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"resource_name" text,
	"drive_id" text,
	"page_id" text,
	"session_id" text,
	"request_id" text,
	"ip" text,
	"user_agent" text,
	"endpoint" text,
	"changes" jsonb,
	"metadata" jsonb,
	"success" boolean DEFAULT true,
	"error_message" text,
	"anonymized" boolean DEFAULT false,
	"retention_date" timestamp,
	"service" text DEFAULT 'web',
	"version" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_type" "ai_agent_type" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"operation_type" text NOT NULL,
	"prompt" text,
	"system_prompt" text,
	"conversation_id" text,
	"message_id" text,
	"drive_id" text,
	"page_id" text,
	"tools_called" jsonb,
	"tool_results" jsonb,
	"completion" text,
	"actions_performed" jsonb,
	"duration" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_cost" integer,
	"status" text DEFAULT 'completed' NOT NULL,
	"error" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"action_type" "audit_action_type" NOT NULL,
	"entity_type" "audit_entity_type" NOT NULL,
	"entity_id" text NOT NULL,
	"user_id" text,
	"is_ai_action" boolean DEFAULT false NOT NULL,
	"ai_operation_id" text,
	"drive_id" text,
	"before_state" jsonb,
	"after_state" jsonb,
	"changes" jsonb,
	"description" text,
	"reason" text,
	"metadata" jsonb,
	"request_id" text,
	"session_id" text,
	"ip_address" text,
	"user_agent" text,
	"operation_id" text,
	"parent_event_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"content" jsonb NOT NULL,
	"title" text NOT NULL,
	"page_type" text NOT NULL,
	"metadata" jsonb,
	"audit_event_id" text,
	"created_by" text,
	"is_ai_generated" boolean DEFAULT false NOT NULL,
	"content_size" integer,
	"change_summary" text,
	"change_type" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_operations" ADD CONSTRAINT "ai_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_operations" ADD CONSTRAINT "ai_operations_drive_id_drives_id_fk" FOREIGN KEY ("drive_id") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_operations" ADD CONSTRAINT "ai_operations_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_drive_id_drives_id_fk" FOREIGN KEY ("drive_id") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_audit_event_id_audit_events_id_fk" FOREIGN KEY ("audit_event_id") REFERENCES "public"."audit_events"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_timestamp" ON "audit_logs" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_action" ON "audit_logs" USING btree ("action","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_category" ON "audit_logs" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_user_id" ON "audit_logs" USING btree ("user_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_resource" ON "audit_logs" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_drive_id" ON "audit_logs" USING btree ("drive_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_page_id" ON "audit_logs" USING btree ("page_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_session" ON "audit_logs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_request" ON "audit_logs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_anonymized" ON "audit_logs" USING btree ("anonymized");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_retention" ON "audit_logs" USING btree ("retention_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_success" ON "audit_logs" USING btree ("success","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_operations_user_created_idx" ON "ai_operations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_operations_drive_created_idx" ON "ai_operations" USING btree ("drive_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_operations_conversation_idx" ON "ai_operations" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_operations_message_idx" ON "ai_operations" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_operations_page_idx" ON "ai_operations" USING btree ("page_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_operations_agent_type_idx" ON "ai_operations" USING btree ("agent_type","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_operations_provider_model_idx" ON "ai_operations" USING btree ("provider","model");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_operations_status_idx" ON "ai_operations" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_operations_created_at_idx" ON "ai_operations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_drive_created_idx" ON "audit_events" USING btree ("drive_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_user_created_idx" ON "audit_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_action_type_idx" ON "audit_events" USING btree ("action_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_is_ai_action_idx" ON "audit_events" USING btree ("is_ai_action","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_ai_operation_idx" ON "audit_events" USING btree ("ai_operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_operation_id_idx" ON "audit_events" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_request_id_idx" ON "audit_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_versions_page_version_idx" ON "page_versions" USING btree ("page_id","version_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_versions_page_created_idx" ON "page_versions" USING btree ("page_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_versions_created_by_idx" ON "page_versions" USING btree ("created_by","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_versions_is_ai_generated_idx" ON "page_versions" USING btree ("is_ai_generated");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_versions_audit_event_idx" ON "page_versions" USING btree ("audit_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_versions_created_at_idx" ON "page_versions" USING btree ("created_at");