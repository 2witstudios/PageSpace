ALTER TABLE "app_deploy_token_mints" ADD COLUMN "outcome" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "app_deploy_token_mints" ADD COLUMN "settledAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "published_apps" ADD COLUMN "claimedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "published_apps" ADD COLUMN "claimedBy" text;--> statement-breakpoint
ALTER TABLE "app_deploy_token_mints" ADD CONSTRAINT "app_deploy_token_mints_outcome_allowed" CHECK ("app_deploy_token_mints"."outcome" IN ('pending', 'minted', 'failed'));--> statement-breakpoint
ALTER TABLE "app_deploy_token_mints" ADD CONSTRAINT "app_deploy_token_mints_settled_coherent" CHECK (("app_deploy_token_mints"."outcome" = 'pending') = ("app_deploy_token_mints"."settledAt" IS NULL));--> statement-breakpoint
ALTER TABLE "published_apps" ADD CONSTRAINT "published_apps_claim_coherent" CHECK (("published_apps"."claimedAt" IS NULL) = ("published_apps"."claimedBy" IS NULL));