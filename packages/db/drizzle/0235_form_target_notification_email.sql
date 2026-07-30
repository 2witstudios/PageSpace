-- Add notification_email column to form_targets table.
-- Nullable: blank means no email notification on submission (opt-in).
ALTER TABLE "form_targets" ADD COLUMN "notification_email" text;