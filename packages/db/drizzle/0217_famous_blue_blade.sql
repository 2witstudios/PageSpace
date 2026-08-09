ALTER TABLE "machine_projects" ADD COLUMN "sessionKey" text;--> statement-breakpoint
ALTER TABLE "machine_projects" ADD COLUMN "sandboxId" text;--> statement-breakpoint
ALTER TABLE "machine_projects" ADD COLUMN "spriteInstanceId" text;--> statement-breakpoint
ALTER TABLE "machine_projects" ADD COLUMN "teardownRequestedAt" timestamp;--> statement-breakpoint
ALTER TABLE "machine_projects" ADD COLUMN "spriteTornDownAt" timestamp;--> statement-breakpoint
ALTER TABLE "machine_projects" ADD CONSTRAINT "machine_projects_sessionKey_unique" UNIQUE("sessionKey");