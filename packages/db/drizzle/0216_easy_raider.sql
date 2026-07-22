ALTER TABLE "machine_branches" ADD COLUMN "storageLastBilledAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_branches" ADD COLUMN "storageMeasuredBytes" bigint;--> statement-breakpoint
ALTER TABLE "machine_branches" ADD COLUMN "storageMeasuredAt" timestamp;