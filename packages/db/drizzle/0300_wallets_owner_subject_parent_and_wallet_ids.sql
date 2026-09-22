CREATE TABLE "wallet_consumer_caps" (
	"walletId" text NOT NULL,
	"consumerKey" text NOT NULL,
	"dailyCapCents" integer,
	"monthlyCapCents" integer,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_consumer_caps_pkey" PRIMARY KEY("walletId","consumerKey"),
	CONSTRAINT "wallet_consumer_caps_consumer_key_nonempty" CHECK (length("wallet_consumer_caps"."consumerKey") > 0),
	CONSTRAINT "wallet_consumer_caps_daily_nonneg" CHECK ("wallet_consumer_caps"."dailyCapCents" IS NULL OR "wallet_consumer_caps"."dailyCapCents" >= 0),
	CONSTRAINT "wallet_consumer_caps_monthly_nonneg" CHECK ("wallet_consumer_caps"."monthlyCapCents" IS NULL OR "wallet_consumer_caps"."monthlyCapCents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "wallets" DROP CONSTRAINT "credit_balances_monthly_remaining_nonneg";--> statement-breakpoint
ALTER TABLE "wallets" DROP CONSTRAINT "credit_balances_monthly_allowance_nonneg";--> statement-breakpoint
ALTER TABLE "wallets" DROP CONSTRAINT "credit_balances_topup_remaining_nonneg";--> statement-breakpoint
ALTER TABLE "wallets" DROP CONSTRAINT "credit_balances_debt_cents_nonneg";--> statement-breakpoint
ALTER TABLE "wallets" DROP CONSTRAINT "credit_balances_pending_millicents_range";--> statement-breakpoint
ALTER TABLE "wallets" DROP CONSTRAINT "credit_balances_period_order";--> statement-breakpoint
/* 
    Unfortunately in current drizzle-kit version we can't automatically get name for primary key.
    We are working on making it available!

    Meanwhile you can:
        1. Check pk name in your database, by running
            SELECT constraint_name FROM information_schema.table_constraints
            WHERE table_schema = 'public'
                AND table_name = 'wallets'
                AND constraint_type = 'PRIMARY KEY';
        2. Uncomment code below and paste pk name manually
        
    Hope to release this update as soon as possible
*/

-- ALTER TABLE "wallets" DROP CONSTRAINT "<constraint_name>";--> statement-breakpoint
ALTER TABLE "wallets" ALTER COLUMN "userId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD COLUMN "wallet_id" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "id" text PRIMARY KEY DEFAULT ('w' || substr(md5(random()::text || clock_timestamp()::text), 1, 23)) NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "ownerType" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "orgId" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "subjectType" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "subjectId" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "parentWalletId" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "spentCents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "donationsEnabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "fallbackRule" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "createdAt" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_holds" ADD COLUMN "walletId" text;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "walletId" text;--> statement-breakpoint
ALTER TABLE "wallet_consumer_caps" ADD CONSTRAINT "wallet_consumer_caps_walletId_wallets_id_fk" FOREIGN KEY ("walletId") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_orgId_organizations_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_parentWalletId_wallets_id_fk" FOREIGN KEY ("parentWalletId") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_walletId_wallets_id_fk" FOREIGN KEY ("walletId") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_walletId_wallets_id_fk" FOREIGN KEY ("walletId") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_personal_root_unique" ON "wallets" USING btree ("userId") WHERE "ownerType" = 'user' AND "subjectType" IS NULL AND "parentWalletId" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_org_pool_unique" ON "wallets" USING btree ("orgId") WHERE "ownerType" = 'org' AND "subjectType" IS NULL AND "parentWalletId" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_subject_unique" ON "wallets" USING btree ("subjectType","subjectId") WHERE "subjectId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "wallets_parent_idx" ON "wallets" USING btree ("parentWalletId");--> statement-breakpoint
CREATE INDEX "credit_holds_wallet_idx" ON "credit_holds" USING btree ("walletId");--> statement-breakpoint
CREATE INDEX "credit_ledger_wallet_idx" ON "credit_ledger" USING btree ("walletId","createdAt");--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_owner_type_valid" CHECK ("wallets"."ownerType" IN ('user', 'org'));--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_owner_matches_type" CHECK (("wallets"."ownerType" = 'user' AND "wallets"."userId" IS NOT NULL AND "wallets"."orgId" IS NULL) OR ("wallets"."ownerType" = 'org' AND "wallets"."orgId" IS NOT NULL AND "wallets"."userId" IS NULL));--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_subject_type_valid" CHECK ("wallets"."subjectType" IS NULL OR "wallets"."subjectType" IN ('drive', 'agent_page'));--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_subject_complete" CHECK (("wallets"."subjectType" IS NULL) = ("wallets"."subjectId" IS NULL));--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_not_own_parent" CHECK ("wallets"."parentWalletId" IS NULL OR "wallets"."parentWalletId" <> "wallets"."id");--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_status_valid" CHECK ("wallets"."status" IN ('active', 'paused', 'over'));--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_fallback_rule_valid" CHECK ("wallets"."fallbackRule" IS NULL OR "wallets"."fallbackRule" IN ('refuse', 'seat_allowance', 'own_credits'));--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_monthly_remaining_nonneg" CHECK ("wallets"."monthlyRemainingCents" >= 0);--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_monthly_allowance_nonneg" CHECK ("wallets"."monthlyAllowanceCents" >= 0);--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_spent_cents_nonneg" CHECK ("wallets"."spentCents" >= 0);--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_topup_remaining_nonneg" CHECK ("wallets"."topupRemainingCents" >= 0);--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_debt_cents_nonneg" CHECK ("wallets"."debtCents" >= 0);--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_pending_millicents_range" CHECK ("wallets"."pendingMillicents" >= 0 AND "wallets"."pendingMillicents" < 1000);--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_period_order" CHECK ("wallets"."monthlyPeriodStart" IS NULL OR "wallets"."monthlyPeriodEnd" IS NULL OR "wallets"."monthlyPeriodStart" <= "wallets"."monthlyPeriodEnd");