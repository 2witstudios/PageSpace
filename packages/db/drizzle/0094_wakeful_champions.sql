-- Migrate users with provider='both' to their OAuth provider before enum change
UPDATE "users" SET "provider" = 'google' WHERE "provider" = 'both' AND "googleId" IS NOT NULL;--> statement-breakpoint
UPDATE "users" SET "provider" = 'apple' WHERE "provider" = 'both' AND "appleId" IS NOT NULL AND "googleId" IS NULL;--> statement-breakpoint
UPDATE "users" SET "provider" = 'email' WHERE "provider" = 'both';--> statement-breakpoint

-- Remove 'both' from AuthProvider enum (PG doesn't support DROP VALUE, so recreate)
ALTER TYPE "AuthProvider" RENAME TO "AuthProvider_old";--> statement-breakpoint
CREATE TYPE "AuthProvider" AS ENUM('email', 'google', 'apple');--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "provider" TYPE "AuthProvider" USING "provider"::text::"AuthProvider";--> statement-breakpoint
DROP TYPE "AuthProvider_old";--> statement-breakpoint

-- Drop the password column
ALTER TABLE "users" DROP COLUMN IF EXISTS "password";
