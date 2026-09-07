ALTER TABLE "dev_preview_services" DROP CONSTRAINT "dev_preview_services_relay_iff_not_8080_check";--> statement-breakpoint
ALTER TABLE "dev_preview_services" ADD COLUMN "approvedPort" integer;--> statement-breakpoint
ALTER TABLE "dev_preview_services" ADD COLUMN "approvedAt" timestamp;--> statement-breakpoint
ALTER TABLE "dev_preview_services" ADD COLUMN "approvedByUserId" text;--> statement-breakpoint
ALTER TABLE "dev_preview_services" ADD CONSTRAINT "dev_preview_services_approvedByUserId_users_id_fk" FOREIGN KEY ("approvedByUserId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_preview_services" ADD CONSTRAINT "dev_preview_services_relay_never_8080_check" CHECK ("dev_preview_services"."relayServiceName" IS NULL OR "dev_preview_services"."targetPort" <> 8080);--> statement-breakpoint
ALTER TABLE "dev_preview_services" ADD CONSTRAINT "dev_preview_services_approved_port_range_check" CHECK ("dev_preview_services"."approvedPort" IS NULL OR "dev_preview_services"."approvedPort" BETWEEN 1 AND 65535);--> statement-breakpoint
ALTER TABLE "dev_preview_services" ADD CONSTRAINT "dev_preview_services_approved_paired_check" CHECK (("dev_preview_services"."approvedPort" IS NULL) = ("dev_preview_services"."approvedAt" IS NULL));