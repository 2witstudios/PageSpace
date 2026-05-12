ALTER TABLE "users" ADD COLUMN "betaFeatures" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "codexThreadId" text;