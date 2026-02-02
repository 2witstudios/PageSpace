DO $$ BEGIN
 CREATE TYPE "public"."integration_connection_status" AS ENUM('active', 'expired', 'error', 'pending', 'revoked');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."integration_provider_type" AS ENUM('builtin', 'openapi', 'custom', 'mcp', 'webhook');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."integration_visibility" AS ENUM('private', 'owned_drives', 'all_drives');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "global_assistant_config" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"enabled_user_integrations" jsonb,
	"drive_overrides" jsonb,
	"inherit_drive_integrations" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "global_assistant_config_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"drive_id" text NOT NULL,
	"agent_id" text,
	"user_id" text,
	"connection_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"input_summary" text,
	"success" boolean NOT NULL,
	"response_code" integer,
	"error_type" text,
	"error_message" text,
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text,
	"drive_id" text,
	"name" text NOT NULL,
	"status" "integration_connection_status" DEFAULT 'pending' NOT NULL,
	"status_message" text,
	"credentials" jsonb,
	"base_url_override" text,
	"config_overrides" jsonb,
	"account_metadata" jsonb,
	"visibility" "integration_visibility" DEFAULT 'owned_drives',
	"oauth_state" text,
	"connected_by" text,
	"connected_at" timestamp,
	"last_used_at" timestamp,
	"last_health_check" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "integration_connections_user_provider" UNIQUE("user_id","provider_id"),
	CONSTRAINT "integration_connections_drive_provider" UNIQUE("drive_id","provider_id"),
	CONSTRAINT "integration_connections_scope_chk" CHECK (("user_id" IS NOT NULL AND "drive_id" IS NULL) OR ("user_id" IS NULL AND "drive_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon_url" text,
	"documentation_url" text,
	"provider_type" "integration_provider_type" NOT NULL,
	"config" jsonb NOT NULL,
	"openapi_spec" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"drive_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "integration_providers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_tool_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"allowed_tools" jsonb,
	"denied_tools" jsonb,
	"read_only" boolean DEFAULT false NOT NULL,
	"rate_limit_override" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "integration_tool_grants_agent_connection" UNIQUE("agent_id","connection_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "global_assistant_config" ADD CONSTRAINT "global_assistant_config_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_audit_log" ADD CONSTRAINT "integration_audit_log_drive_id_drives_id_fk" FOREIGN KEY ("drive_id") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_audit_log" ADD CONSTRAINT "integration_audit_log_agent_id_pages_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_audit_log" ADD CONSTRAINT "integration_audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_audit_log" ADD CONSTRAINT "integration_audit_log_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_provider_id_integration_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."integration_providers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_drive_id_drives_id_fk" FOREIGN KEY ("drive_id") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_providers" ADD CONSTRAINT "integration_providers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_providers" ADD CONSTRAINT "integration_providers_drive_id_drives_id_fk" FOREIGN KEY ("drive_id") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_tool_grants" ADD CONSTRAINT "integration_tool_grants_agent_id_pages_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_tool_grants" ADD CONSTRAINT "integration_tool_grants_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_audit_log_drive_id_idx" ON "integration_audit_log" USING btree ("drive_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_audit_log_connection_id_idx" ON "integration_audit_log" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_audit_log_created_at_idx" ON "integration_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_audit_log_drive_created_at_idx" ON "integration_audit_log" USING btree ("drive_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_connections_provider_id_idx" ON "integration_connections" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_connections_user_id_idx" ON "integration_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_connections_drive_id_idx" ON "integration_connections" USING btree ("drive_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_providers_slug_idx" ON "integration_providers" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_providers_drive_id_idx" ON "integration_providers" USING btree ("drive_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_tool_grants_agent_id_idx" ON "integration_tool_grants" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_tool_grants_connection_id_idx" ON "integration_tool_grants" USING btree ("connection_id");