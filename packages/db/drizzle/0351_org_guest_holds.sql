CREATE TABLE "org_guest_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"orgId" text NOT NULL,
	"driveId" text NOT NULL,
	"userId" text,
	"email" text,
	"state" text NOT NULL,
	"origin" text NOT NULL,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parked" jsonb,
	"requestedBy" text,
	"createdAt" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	CONSTRAINT "org_guest_holds_shape" CHECK (("org_guest_holds"."userId" IS NOT NULL) <> ("org_guest_holds"."email" IS NOT NULL) AND ("org_guest_holds"."state" <> 'suspended' OR "org_guest_holds"."userId" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "org_guest_holds" ADD CONSTRAINT "org_guest_holds_orgId_organizations_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_guest_holds" ADD CONSTRAINT "org_guest_holds_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_guest_holds" ADD CONSTRAINT "org_guest_holds_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_guest_holds" ADD CONSTRAINT "org_guest_holds_requestedBy_users_id_fk" FOREIGN KEY ("requestedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_guest_holds_org_state_idx" ON "org_guest_holds" USING btree ("orgId","state");--> statement-breakpoint
CREATE INDEX "org_guest_holds_drive_id_idx" ON "org_guest_holds" USING btree ("driveId");--> statement-breakpoint
CREATE INDEX "org_guest_holds_user_id_idx" ON "org_guest_holds" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "org_guest_holds_user_drive_state_key" ON "org_guest_holds" USING btree ("driveId","userId","state") WHERE "org_guest_holds"."userId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "org_guest_holds_email_drive_state_key" ON "org_guest_holds" USING btree ("driveId",lower("email"),"state") WHERE "org_guest_holds"."userId" IS NULL AND "org_guest_holds"."email" IS NOT NULL;