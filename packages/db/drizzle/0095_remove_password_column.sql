-- Step 2: Convert column to new enum (values are now committed) and clean up
ALTER TABLE "users" ALTER COLUMN "provider" TYPE "AuthProvider" USING "provider"::text::"AuthProvider";--> statement-breakpoint
DROP TYPE "AuthProvider_old";--> statement-breakpoint

-- Drop the password column
ALTER TABLE "users" DROP COLUMN IF EXISTS "password";
