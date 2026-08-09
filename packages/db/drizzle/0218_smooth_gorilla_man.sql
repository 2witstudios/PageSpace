ALTER TABLE "machine_projects" ADD COLUMN "storageLastBilledAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_projects" ADD COLUMN "storageMeasuredBytes" bigint;--> statement-breakpoint
ALTER TABLE "machine_projects" ADD COLUMN "storageMeasuredAt" timestamp;