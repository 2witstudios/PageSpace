CREATE TABLE "org_subscription_funding" (
	"id" text PRIMARY KEY NOT NULL,
	"orgId" text NOT NULL,
	"stripeSubscriptionId" text NOT NULL,
	"stripeInvoiceId" text NOT NULL,
	"basis" text NOT NULL,
	"paidCents" integer NOT NULL,
	"verifiedAt" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	CONSTRAINT "org_subscription_funding_stripeInvoiceId_unique" UNIQUE("stripeInvoiceId"),
	CONSTRAINT "org_subscription_funding_org_subscription_key" UNIQUE("orgId","stripeSubscriptionId"),
	CONSTRAINT "org_subscription_funding_evidence_check" CHECK (("org_subscription_funding"."basis" = 'paid' AND "org_subscription_funding"."paidCents" > 0) OR ("org_subscription_funding"."basis" = 'gift' AND "org_subscription_funding"."paidCents" >= 0))
);
--> statement-breakpoint
ALTER TABLE "org_subscription_funding" ADD CONSTRAINT "org_subscription_funding_orgId_organizations_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;