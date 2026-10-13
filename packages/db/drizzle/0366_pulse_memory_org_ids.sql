ALTER TABLE "pulse_summaries" ADD COLUMN "orgIds" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "personalization_candidates" ADD COLUMN "orgIds" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "user_personalization" ADD COLUMN "memoryOrgIds" text[] DEFAULT ARRAY[]::text[] NOT NULL;