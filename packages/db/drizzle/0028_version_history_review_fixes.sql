-- PR #118 Code Review Fixes: Add contentFormat enum and rollback source snapshot fields

-- Create content_format enum for proper content parsing validation
DO $$ BEGIN
 CREATE TYPE "public"."content_format" AS ENUM('text', 'html', 'json', 'tiptap');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Convert contentFormat from text to enum (safe: NULL values remain NULL, invalid values would fail)
ALTER TABLE "activity_logs" ALTER COLUMN "contentFormat" SET DATA TYPE content_format USING "contentFormat"::content_format;
--> statement-breakpoint

-- Add rollback source snapshot fields for audit trail preservation
-- These denormalized fields survive retention policy deletion of source activities
ALTER TABLE "activity_logs" ADD COLUMN "rollbackSourceOperation" "activity_operation";
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "rollbackSourceTimestamp" timestamp;
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "rollbackSourceTitle" text;
--> statement-breakpoint

-- Add CHECK constraint for retentionDays: must be >= -1 (where -1 = unlimited)
ALTER TABLE "retention_policies" ADD CONSTRAINT valid_retention_days CHECK ("retentionDays" >= -1);
