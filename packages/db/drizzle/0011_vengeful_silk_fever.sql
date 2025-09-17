ALTER TYPE "NotificationType" ADD VALUE 'CONNECTION_REQUEST';--> statement-breakpoint
ALTER TYPE "NotificationType" ADD VALUE 'CONNECTION_ACCEPTED';--> statement-breakpoint
ALTER TYPE "NotificationType" ADD VALUE 'CONNECTION_REJECTED';--> statement-breakpoint
ALTER TYPE "NotificationType" ADD VALUE 'NEW_DIRECT_MESSAGE';--> statement-breakpoint
DROP INDEX IF EXISTS "user_profiles_username_idx";--> statement-breakpoint
ALTER TABLE "user_profiles" ALTER COLUMN "username" DROP NOT NULL;