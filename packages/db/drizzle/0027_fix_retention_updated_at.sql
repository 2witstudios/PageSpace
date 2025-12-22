-- Fix missing DEFAULT value for updatedAt in retention_policies table
ALTER TABLE "retention_policies" ALTER COLUMN "updatedAt" SET DEFAULT now();

-- Add index on rollbackFromActivityId for rollback chain queries
CREATE INDEX IF NOT EXISTS "idx_activity_logs_rollback_from" ON "activity_logs" ("rollbackFromActivityId");
