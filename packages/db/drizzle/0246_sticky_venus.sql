ALTER TABLE "users" ADD COLUMN "starterSkillsInstalledAt" timestamp;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "planPageId" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_planPageId_pages_id_fk" FOREIGN KEY ("planPageId") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_plan_page_id_idx" ON "conversations" USING btree ("planPageId");