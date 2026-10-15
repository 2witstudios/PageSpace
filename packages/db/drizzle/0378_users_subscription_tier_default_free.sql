-- The users."subscriptionTier" column was added with DEFAULT 'normal' (the
-- pre-September-2025 name of the free tier). The schema moved to 'free' and a
-- migration set the new default, but that migration was deleted when the
-- migration history was rewritten in October 2025, so databases created before
-- the rewrite kept DEFAULT 'normal'. Every signup path that leaves the tier to
-- the column default (magic link, passkey) then created 'normal' users while
-- the OAuth and admin paths, which set 'free' explicitly, created 'free' users.
--
-- Custom migration (`drizzle-kit generate --custom`): the schema already says
-- DEFAULT 'free', so drizzle-kit sees no diff to generate. Both statements are
-- no-ops on a database whose default was already 'free'.

UPDATE "users" SET "subscriptionTier" = 'free' WHERE "subscriptionTier" = 'normal';
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "subscriptionTier" SET DEFAULT 'free';
