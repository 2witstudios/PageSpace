CREATE TABLE "wallet_funding_legs" (
	"id" text PRIMARY KEY NOT NULL,
	"walletId" text NOT NULL,
	"funderKind" text NOT NULL,
	"funderUserId" text,
	"funderOrgId" text,
	"originalCents" integer NOT NULL,
	"remainingCents" integer NOT NULL,
	"nonRefundable" boolean NOT NULL,
	"sourceRef" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_funding_legs_funder_kind_valid" CHECK ("wallet_funding_legs"."funderKind" IN ('owner', 'donation')),
	CONSTRAINT "wallet_funding_legs_original_positive" CHECK ("wallet_funding_legs"."originalCents" > 0),
	CONSTRAINT "wallet_funding_legs_remaining_range" CHECK ("wallet_funding_legs"."remainingCents" >= 0 AND "wallet_funding_legs"."remainingCents" <= "wallet_funding_legs"."originalCents"),
	CONSTRAINT "wallet_funding_legs_donation_non_refundable" CHECK ("wallet_funding_legs"."funderKind" <> 'donation' OR "wallet_funding_legs"."nonRefundable"),
	CONSTRAINT "wallet_funding_legs_donation_not_from_org" CHECK ("wallet_funding_legs"."funderKind" <> 'donation' OR "wallet_funding_legs"."funderOrgId" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "wallet_funding_legs" ADD CONSTRAINT "wallet_funding_legs_walletId_wallets_id_fk" FOREIGN KEY ("walletId") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_legs" ADD CONSTRAINT "wallet_funding_legs_funderUserId_users_id_fk" FOREIGN KEY ("funderUserId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_legs" ADD CONSTRAINT "wallet_funding_legs_funderOrgId_organizations_id_fk" FOREIGN KEY ("funderOrgId") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_funding_legs_wallet_order_idx" ON "wallet_funding_legs" USING btree ("walletId","createdAt","id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_funding_legs_source_ref_unique" ON "wallet_funding_legs" USING btree ("sourceRef") WHERE "sourceRef" IS NOT NULL;