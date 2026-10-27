DO $$ BEGIN
 CREATE TYPE "public"."data_subject_request_status" AS ENUM('pending', 'queued', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."data_subject_request_type" AS ENUM('erasure', 'export', 'access', 'rectification', 'restriction', 'portability', 'objection');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."data_subject_requester_type" AS ENUM('self', 'admin');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_subject_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"subject_email" text NOT NULL,
	"request_type" "data_subject_request_type" DEFAULT 'erasure' NOT NULL,
	"status" "data_subject_request_status" DEFAULT 'pending' NOT NULL,
	"force_delete" boolean DEFAULT false NOT NULL,
	"requested_by_user_id" text,
	"requested_by_type" "data_subject_requester_type" DEFAULT 'self' NOT NULL,
	"legal_basis" text,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"sla_deadline" timestamp NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"blocked_reason" text,
	"job_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"step_results" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_subject_requests_status_idx" ON "data_subject_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_subject_requests_sla_deadline_idx" ON "data_subject_requests" USING btree ("sla_deadline");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_subject_requests_user_id_idx" ON "data_subject_requests" USING btree ("user_id");