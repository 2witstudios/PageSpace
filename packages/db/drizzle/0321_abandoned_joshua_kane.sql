CREATE TABLE "org_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"orgId" text NOT NULL,
	"stripeSubscriptionId" text NOT NULL,
	"stripeBasePriceId" text NOT NULL,
	"stripeBaseItemId" text NOT NULL,
	"stripeSeatPriceId" text NOT NULL,
	"stripeSeatItemId" text NOT NULL,
	"extraSeatQuantity" integer DEFAULT 0 NOT NULL,
	"seatRevision" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"trialEnd" timestamp,
	"currentPeriodStart" timestamp,
	"currentPeriodEnd" timestamp,
	"cancelAtPeriodEnd" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	"updatedAt" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	CONSTRAINT "org_subscriptions_orgId_unique" UNIQUE("orgId"),
	CONSTRAINT "org_subscriptions_stripeSubscriptionId_unique" UNIQUE("stripeSubscriptionId")
);
--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD CONSTRAINT "org_subscriptions_orgId_organizations_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;