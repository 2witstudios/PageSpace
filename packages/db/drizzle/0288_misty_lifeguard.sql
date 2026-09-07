--> Written to be RE-RUNNABLE, for the reason 0287 records: this runner keys
--> applied migrations by a hash of the file text, so any edit to a file some
--> database has already applied makes that database run it again — and
--> `Dockerfile.migrate` runs `db:migrate` as the deployment command, so a
--> second pass that fails blocks the rollout rather than just the migration.
--> Every statement below is therefore guarded.
ALTER TABLE "dev_preview_services" DROP CONSTRAINT IF EXISTS "dev_preview_services_relay_iff_not_8080_check";--> statement-breakpoint
ALTER TABLE "dev_preview_services" ADD COLUMN IF NOT EXISTS "approvedPort" integer;--> statement-breakpoint
ALTER TABLE "dev_preview_services" ADD COLUMN IF NOT EXISTS "approvedAt" timestamp;--> statement-breakpoint
ALTER TABLE "dev_preview_services" ADD COLUMN IF NOT EXISTS "approvedByUserId" text;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dev_preview_services_approvedByUserId_users_id_fk' AND conrelid = '"dev_preview_services"'::regclass) THEN
		ALTER TABLE "dev_preview_services" ADD CONSTRAINT "dev_preview_services_approvedByUserId_users_id_fk" FOREIGN KEY ("approvedByUserId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dev_preview_services_relay_never_8080_check' AND conrelid = '"dev_preview_services"'::regclass) THEN
		ALTER TABLE "dev_preview_services" ADD CONSTRAINT "dev_preview_services_relay_never_8080_check" CHECK ("dev_preview_services"."relayServiceName" IS NULL OR "dev_preview_services"."targetPort" <> 8080);
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dev_preview_services_approved_port_range_check' AND conrelid = '"dev_preview_services"'::regclass) THEN
		ALTER TABLE "dev_preview_services" ADD CONSTRAINT "dev_preview_services_approved_port_range_check" CHECK ("dev_preview_services"."approvedPort" IS NULL OR "dev_preview_services"."approvedPort" BETWEEN 1 AND 65535);
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dev_preview_services_approved_paired_check' AND conrelid = '"dev_preview_services"'::regclass) THEN
		ALTER TABLE "dev_preview_services" ADD CONSTRAINT "dev_preview_services_approved_paired_check" CHECK (("dev_preview_services"."approvedPort" IS NULL) = ("dev_preview_services"."approvedAt" IS NULL));
	END IF;
END $$;
