CREATE TABLE "org_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"orgId" text NOT NULL,
	"domain" text NOT NULL,
	"dnsToken" text NOT NULL,
	"emailTokenHash" text,
	"emailTokenExpiresAt" timestamp,
	"emailSentTo" text,
	"verifiedAt" timestamp,
	"verifiedMethod" text,
	"createdBy" text,
	"createdAt" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	CONSTRAINT "org_domains_emailTokenHash_unique" UNIQUE("emailTokenHash"),
	CONSTRAINT "org_domains_org_domain_key" UNIQUE("orgId","domain")
);
--> statement-breakpoint
CREATE TABLE "org_member_departures" (
	"id" text PRIMARY KEY NOT NULL,
	"orgId" text NOT NULL,
	"userId" text NOT NULL,
	"reason" text NOT NULL,
	"departedAt" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	CONSTRAINT "org_member_departures_org_user_key" UNIQUE("orgId","userId")
);
--> statement-breakpoint
ALTER TABLE "org_domains" ADD CONSTRAINT "org_domains_orgId_organizations_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_domains" ADD CONSTRAINT "org_domains_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_member_departures" ADD CONSTRAINT "org_member_departures_orgId_organizations_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_member_departures" ADD CONSTRAINT "org_member_departures_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_domains_verified_domain_key" ON "org_domains" USING btree ("domain") WHERE "org_domains"."verifiedAt" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "org_member_departures_user_id_idx" ON "org_member_departures" USING btree ("userId");