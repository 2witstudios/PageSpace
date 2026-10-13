ALTER TYPE "public"."NotificationType" ADD VALUE 'WALLET_CAP_ALERT' BEFORE 'PRODUCT_UPDATE';--> statement-breakpoint
CREATE TABLE "wallet_cap_alerts" (
	"walletId" text NOT NULL,
	"consumerKey" text NOT NULL,
	"capWindow" text NOT NULL,
	"periodStart" timestamp with time zone NOT NULL,
	"threshold" integer NOT NULL,
	"sentAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_cap_alerts_pkey" PRIMARY KEY("walletId","consumerKey","capWindow","periodStart","threshold"),
	CONSTRAINT "wallet_cap_alerts_window_valid" CHECK ("wallet_cap_alerts"."capWindow" IN ('daily', 'monthly')),
	CONSTRAINT "wallet_cap_alerts_threshold_valid" CHECK ("wallet_cap_alerts"."threshold" IN (80, 100))
);
--> statement-breakpoint
ALTER TABLE "credit_holds" ADD COLUMN "fallbackFromWalletId" text;--> statement-breakpoint
ALTER TABLE "wallet_cap_alerts" ADD CONSTRAINT "wallet_cap_alerts_walletId_wallets_id_fk" FOREIGN KEY ("walletId") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_fallbackFromWalletId_wallets_id_fk" FOREIGN KEY ("fallbackFromWalletId") REFERENCES "public"."wallets"("id") ON DELETE set null ON UPDATE no action;