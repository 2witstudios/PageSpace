ALTER TYPE "public"."NotificationType" ADD VALUE 'WALLET_DEBT' BEFORE 'PRODUCT_UPDATE';--> statement-breakpoint
CREATE TABLE "wallet_debt_notices" (
	"walletId" text PRIMARY KEY NOT NULL,
	"lastNotifiedAt" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "overshootChoice" text;--> statement-breakpoint
ALTER TABLE "wallet_debt_notices" ADD CONSTRAINT "wallet_debt_notices_walletId_wallets_id_fk" FOREIGN KEY ("walletId") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_overshoot_choice_valid" CHECK ("wallets"."overshootChoice" IS NULL OR ("wallets"."overshootChoice" IN ('absorb_to_parent', 'wallet_debt') AND "wallets"."parentWalletId" IS NOT NULL));