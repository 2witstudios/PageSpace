ALTER TABLE "machine_sessions" ADD COLUMN "teardownRequestedAt" timestamp;--> statement-breakpoint
ALTER TABLE "machine_branches" ADD COLUMN "teardownRequestedAt" timestamp;