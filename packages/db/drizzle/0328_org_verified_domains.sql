CREATE TABLE "org_domain_joins" (
	"id" text PRIMARY KEY NOT NULL,
	"orgId" text NOT NULL,
	"userId" text NOT NULL,
	"domain" text NOT NULL,
	"joinedAt" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	CONSTRAINT "org_domain_joins_org_user_key" UNIQUE("orgId","userId")
);
--> statement-breakpoint
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
ALTER TABLE "org_domain_joins" ADD CONSTRAINT "org_domain_joins_orgId_organizations_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_domain_joins" ADD CONSTRAINT "org_domain_joins_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_domains" ADD CONSTRAINT "org_domains_orgId_organizations_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_domains" ADD CONSTRAINT "org_domains_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_domain_joins_user_id_idx" ON "org_domain_joins" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "org_domains_verified_domain_key" ON "org_domains" USING btree ("domain") WHERE "org_domains"."verifiedAt" IS NOT NULL;