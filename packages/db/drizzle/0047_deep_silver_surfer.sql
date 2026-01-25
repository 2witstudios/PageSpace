-- Backfill NULL values before adding NOT NULL constraint
UPDATE "security_audit_log" SET "previous_hash" = 'genesis' WHERE "previous_hash" IS NULL;
ALTER TABLE "security_audit_log" ALTER COLUMN "previous_hash" SET NOT NULL;