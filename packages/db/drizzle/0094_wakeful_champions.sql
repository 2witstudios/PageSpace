-- Migrate users with provider='both' to their OAuth provider before enum change
-- Users with both googleId and appleId are assigned to 'google' (first linked provider takes priority)
-- Note: 'both' is left in the DB enum as a harmless unused value because PostgreSQL
-- cannot drop enum values in a transaction (Drizzle runs all migrations in one transaction).
UPDATE "users" SET "provider" = 'google' WHERE "provider" = 'both' AND "googleId" IS NOT NULL;--> statement-breakpoint
UPDATE "users" SET "provider" = 'apple' WHERE "provider" = 'both' AND "appleId" IS NOT NULL AND "googleId" IS NULL;--> statement-breakpoint
UPDATE "users" SET "provider" = 'email' WHERE "provider" = 'both';--> statement-breakpoint

-- Drop the password column
ALTER TABLE "users" DROP COLUMN IF EXISTS "password";
