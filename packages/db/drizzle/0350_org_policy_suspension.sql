ALTER TABLE "drive_members" ADD COLUMN "suspendedByPolicy" text;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "suspended_by_policy" text;--> statement-breakpoint
ALTER TABLE "drive_share_links" ADD COLUMN "suspended_by_policy" text;--> statement-breakpoint
ALTER TABLE "page_share_links" ADD COLUMN "suspended_by_policy" text;--> statement-breakpoint
ALTER TABLE "published_pages" ADD COLUMN "suspended_by_policy" text;--> statement-breakpoint
ALTER TABLE "custom_domains" ADD COLUMN "suspended_by_policy" text;--> statement-breakpoint
CREATE INDEX "drive_members_suspended_by_policy_idx" ON "drive_members" USING btree ("driveId") WHERE "drive_members"."suspendedByPolicy" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "integration_connections_suspended_by_policy_idx" ON "integration_connections" USING btree ("drive_id") WHERE "integration_connections"."suspended_by_policy" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "drive_share_links_suspended_by_policy_idx" ON "drive_share_links" USING btree ("drive_id") WHERE "drive_share_links"."suspended_by_policy" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "page_share_links_suspended_by_policy_idx" ON "page_share_links" USING btree ("page_id") WHERE "page_share_links"."suspended_by_policy" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "published_pages_suspended_by_policy_idx" ON "published_pages" USING btree ("drive_id") WHERE "published_pages"."suspended_by_policy" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "custom_domains_suspended_by_policy_idx" ON "custom_domains" USING btree ("drive_id") WHERE "custom_domains"."suspended_by_policy" IS NOT NULL;