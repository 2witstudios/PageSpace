ALTER TABLE "drives" ADD COLUMN "isTrashed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "drives" ADD COLUMN "trashedAt" timestamp;