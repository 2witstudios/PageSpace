CREATE TABLE IF NOT EXISTS "credit_balances" (
	"userId" text PRIMARY KEY NOT NULL,
	"monthlyRemainingCents" integer DEFAULT 0 NOT NULL,
	"monthlyAllowanceCents" integer DEFAULT 0 NOT NULL,
	"topupRemainingCents" integer DEFAULT 0 NOT NULL,
	"monthlyPeriodStart" timestamp with time zone,
	"monthlyPeriodEnd" timestamp with time zone,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"entryType" text NOT NULL,
	"bucket" text NOT NULL,
	"amountCents" integer NOT NULL,
	"aiUsageLogId" text,
	"realCostCents" integer,
	"markupBps" integer DEFAULT 15000 NOT NULL,
	"stripeRef" text,
	"consumeStatus" text DEFAULT 'pending' NOT NULL,
	"consumeError" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_ledger_user_idx" ON "credit_ledger" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_usage_log_unique" ON "credit_ledger" USING btree ("aiUsageLogId") WHERE "credit_ledger"."aiUsageLogId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_stripe_ref_unique" ON "credit_ledger" USING btree ("stripeRef") WHERE "credit_ledger"."stripeRef" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_ledger_consume_status_idx" ON "credit_ledger" USING btree ("consumeStatus","createdAt");