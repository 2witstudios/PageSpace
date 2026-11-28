-- users."subscriptionTier" was added with DEFAULT 'normal' (the pre-September-2025
-- name of the free tier). The migration that changed the default to 'free' was
-- deleted when the migration history was rewritten in October 2025, so databases
-- created before the rewrite kept DEFAULT 'normal', and every signup path that
-- leaves the tier to the column default (magic link, passkey) created 'normal'
-- users while OAuth and admin-created users got 'free'.
--
-- Journaled immediately before 0360, whose CHECK allows only 'free'/'pro' and is
-- validated against existing rows: on such a database the backfill must run
-- first or 0360 can never apply. The runner applies by hash in journal order, so
-- a database already past 0360 runs this too; there it only fixes the default.
--
-- Custom migration (`drizzle-kit generate --custom`): the schema already says
-- DEFAULT 'free', so drizzle-kit has no diff to generate. No snapshot of its own;
-- the "0359a" prefix keeps fix-migrations.yml from pairing it with 0359's.

UPDATE "users" SET "subscriptionTier" = 'free' WHERE "subscriptionTier" = 'normal';
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "subscriptionTier" SET DEFAULT 'free';
