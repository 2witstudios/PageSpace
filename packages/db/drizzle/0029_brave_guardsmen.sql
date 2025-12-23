DO $$ BEGIN
 CREATE TYPE "public"."subscription_tier" AS ENUM('free', 'pro', 'business', 'founder');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "retention_policies" ALTER COLUMN "subscriptionTier" SET DATA TYPE subscription_tier USING "subscriptionTier"::subscription_tier;