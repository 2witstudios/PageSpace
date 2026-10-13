ALTER TYPE "public"."NotificationType" ADD VALUE 'WALLET_DEBT' BEFORE 'PRODUCT_UPDATE';--> statement-breakpoint
CREATE TABLE "wallet_debt_notices" (
	"walletId" text PRIMARY KEY NOT NULL,
	"lastNotifiedAt" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "overshootChoice" text;--> statement-breakpoint
ALTER TABLE "published_apps" ADD COLUMN "costOwnerId" text;--> statement-breakpoint
ALTER TABLE "drive_envs" ADD COLUMN "costOwnerId" text;--> statement-breakpoint
ALTER TABLE "wallet_debt_notices" ADD CONSTRAINT "wallet_debt_notices_walletId_wallets_id_fk" FOREIGN KEY ("walletId") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_apps" ADD CONSTRAINT "published_apps_costOwnerId_users_id_fk" FOREIGN KEY ("costOwnerId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_envs" ADD CONSTRAINT "drive_envs_costOwnerId_users_id_fk" FOREIGN KEY ("costOwnerId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "published_apps_cost_owner_idx" ON "published_apps" USING btree ("costOwnerId");--> statement-breakpoint
CREATE INDEX "drive_envs_cost_owner_idx" ON "drive_envs" USING btree ("costOwnerId");--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_overshoot_choice_valid" CHECK ("wallets"."overshootChoice" IS NULL OR ("wallets"."overshootChoice" IN ('absorb_to_parent', 'wallet_debt') AND "wallets"."parentWalletId" IS NOT NULL));