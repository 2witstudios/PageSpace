ALTER TABLE "calendar_triggers" ALTER COLUMN "occurrenceDate" SET DEFAULT '1970-01-01T00:00:00.000Z';--> statement-breakpoint
ALTER TABLE "calendar_triggers" ALTER COLUMN "occurrenceDate" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "password";