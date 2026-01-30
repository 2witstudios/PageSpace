DROP TABLE "feedback_attachments";--> statement-breakpoint
ALTER TABLE "feedback_submissions" ADD COLUMN "attachments" jsonb;