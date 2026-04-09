-- Migrate users with provider='both' to their OAuth provider before enum change
UPDATE "users" SET "provider" = 'google' WHERE "provider" = 'both' AND "googleId" IS NOT NULL;--> statement-breakpoint
UPDATE "users" SET "provider" = 'apple' WHERE "provider" = 'both' AND "appleId" IS NOT NULL AND "googleId" IS NULL;--> statement-breakpoint
UPDATE "users" SET "provider" = 'email' WHERE "provider" = 'both';--> statement-breakpoint

-- Remove 'both' from AuthProvider enum (PG doesn't support DROP VALUE, so recreate)
-- Step 1: Rename old enum and create new one (values must be committed before use)
ALTER TYPE "AuthProvider" RENAME TO "AuthProvider_old";--> statement-breakpoint
CREATE TYPE "AuthProvider" AS ENUM('email', 'google', 'apple');
