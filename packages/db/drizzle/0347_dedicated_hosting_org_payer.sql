ALTER TABLE "published_app_subscriptions" DROP CONSTRAINT "published_app_subscriptions_userId_users_id_fk";
--> statement-breakpoint
ALTER TABLE "published_app_subscriptions" ALTER COLUMN "userId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "published_app_subscriptions" ADD COLUMN "orgId" text;--> statement-breakpoint
ALTER TABLE "published_app_subscriptions" ADD CONSTRAINT "published_app_subscriptions_orgId_organizations_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_app_subscriptions" ADD CONSTRAINT "published_app_subscriptions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "published_app_subscriptions_org_idx" ON "published_app_subscriptions" USING btree ("orgId");