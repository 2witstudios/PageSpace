ALTER TYPE "NotificationType" ADD VALUE 'TOS_PRIVACY_UPDATED';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tosAcceptedAt" timestamp;