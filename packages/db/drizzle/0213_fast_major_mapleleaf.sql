DO $$ BEGIN
 CREATE TYPE "public"."broadcast_recipient_status" AS ENUM('pending', 'sent', 'skipped', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."email_broadcast_content_mode" AS ENUM('compose', 'template');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."email_broadcast_engine" AS ENUM('transactional', 'resend_broadcast');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."email_broadcast_status" AS ENUM('draft', 'pending', 'queued', 'in_progress', 'paused', 'completed', 'failed', 'cancelled');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "broadcast_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"broadcast_id" text NOT NULL,
	"user_id" text NOT NULL,
	"recipient_email" text NOT NULL,
	"status" "broadcast_recipient_status" DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp,
	"claimed_at" timestamp,
	"claimed_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "broadcast_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"body_markdown" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_broadcasts" (
	"id" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"engine" "email_broadcast_engine" DEFAULT 'transactional' NOT NULL,
	"content_mode" "email_broadcast_content_mode" DEFAULT 'compose' NOT NULL,
	"template_id" text,
	"body_markdown" text,
	"notification_type" "NotificationType" DEFAULT 'PRODUCT_UPDATE' NOT NULL,
	"audience_definition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "email_broadcast_status" DEFAULT 'draft' NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"send_limit" integer,
	"delay_ms" integer DEFAULT 120 NOT NULL,
	"total_targeted" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"step_results" jsonb,
	"job_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"blocked_reason" text,
	"created_by_user_id" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcast_id_email_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."email_broadcasts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "broadcast_templates" ADD CONSTRAINT "broadcast_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_broadcasts" ADD CONSTRAINT "email_broadcasts_template_id_broadcast_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."broadcast_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_broadcasts" ADD CONSTRAINT "email_broadcasts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "broadcast_recipients_broadcast_user_unique" ON "broadcast_recipients" USING btree ("broadcast_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "broadcast_recipients_broadcast_status_idx" ON "broadcast_recipients" USING btree ("broadcast_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "broadcast_templates_active_idx" ON "broadcast_templates" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_broadcasts_status_idx" ON "email_broadcasts" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_broadcasts_created_at_idx" ON "email_broadcasts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_broadcasts_created_by_idx" ON "email_broadcasts" USING btree ("created_by_user_id");