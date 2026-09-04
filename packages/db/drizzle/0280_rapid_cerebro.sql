ALTER TABLE "users" ADD COLUMN "onboardingCompletedAt" timestamp;--> statement-breakpoint
-- Stamp every user that exists at migration time as already onboarded.
--
-- The first-run gate shows onboarding whenever this column IS NULL, deliberately
-- rather than keying off the `?welcome=true` redirect, so a refresh part-way
-- through the flow resumes instead of stranding the user. The cost of that
-- choice is that every user who predates the feature is also NULL — so without
-- this statement, the entire existing user base is shown a first-run walkthrough
-- on their next login.
--
-- Done here, in the same transaction as the ADD COLUMN, rather than in a
-- standalone backfill script, because the script would have to be remembered and
-- run on every deployment path. Self-hosted upgrades run `db:migrate` from
-- docker-compose and nothing else (infrastructure/UPGRADE.md documents no extra
-- step), so a script would simply never run there. Doing it here also removes a
-- race a script cannot avoid: any account created while a separate backfill was
-- walking the table could be stamped as onboarded and permanently lose the flow.
-- After this migration, NULL means genuinely new.
UPDATE "users" SET "onboardingCompletedAt" = now() WHERE "onboardingCompletedAt" IS NULL;
