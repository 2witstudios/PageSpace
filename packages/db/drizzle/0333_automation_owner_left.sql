ALTER TABLE "calendar_triggers" DROP CONSTRAINT "calendar_triggers_scheduledById_users_id_fk";
--> statement-breakpoint
ALTER TABLE "workflows" DROP CONSTRAINT "workflows_createdBy_users_id_fk";
--> statement-breakpoint
ALTER TABLE "page_webhooks" DROP CONSTRAINT "page_webhooks_createdBy_users_id_fk";
--> statement-breakpoint
ALTER TABLE "calendar_triggers" ALTER COLUMN "scheduledById" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "createdBy" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "page_webhooks" ALTER COLUMN "createdBy" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "ownerLeftAt" timestamp;--> statement-breakpoint
ALTER TABLE "page_webhooks" ADD COLUMN "ownerLeftAt" timestamp;--> statement-breakpoint
ALTER TABLE "calendar_triggers" ADD CONSTRAINT "calendar_triggers_scheduledById_users_id_fk" FOREIGN KEY ("scheduledById") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_webhooks" ADD CONSTRAINT "page_webhooks_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;