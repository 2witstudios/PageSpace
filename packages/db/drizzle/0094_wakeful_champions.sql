-- Migrate users with provider='both' to their OAuth provider before enum change
-- Users with both googleId and appleId are assigned to 'google' (first linked provider takes priority)
-- Note: 'both' is left as an unused value in the DB enum. PostgreSQL cannot drop enum
-- values, and the rename+recreate workaround fails because CREATE TYPE enum values
-- can't be used in the same transaction (even with per-migration transactions).
-- The Drizzle schema excludes 'both', so the app code will never produce it.
UPDATE "users" SET "provider" = 'google' WHERE "provider" = 'both' AND "googleId" IS NOT NULL;--> statement-breakpoint
UPDATE "users" SET "provider" = 'apple' WHERE "provider" = 'both' AND "appleId" IS NOT NULL AND "googleId" IS NULL;--> statement-breakpoint
UPDATE "users" SET "provider" = 'email' WHERE "provider" = 'both';--> statement-breakpoint

-- Drop the password column
ALTER TABLE "users" DROP COLUMN IF EXISTS "password";
