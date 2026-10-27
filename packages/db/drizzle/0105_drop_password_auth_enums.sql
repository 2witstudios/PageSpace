-- Remove password-auth enum values by converting the consuming columns to text
-- and dropping the enum types. Password auth was removed from PageSpace
-- (passwordless-only: passkey + magic link) and these values reference dead
-- functionality.
--
-- Rationale for column->text (not rename-and-swap + DELETE):
--   activity_logs and security_audit_log are tamper-evident hash chains.
--     - computeLogHash in packages/lib/src/monitoring/activity-logger.ts
--       includes `operation` in the hashed payload.
--     - computeSecurityEventHash in packages/lib/src/audit/security-audit.ts
--       includes `event_type` in the hashed payload.
--   Both verifySecurityAuditChain and the activity hash-chain-verifier also
--   require each row's previousHash to match the immediately prior row's
--   stored hash. Either DELETE-ing rows or UPDATE-ing event_type would make
--   the verifiers report chain breaks on unmodified rows.
--   Converting the column to text preserves every stored value verbatim.
--
-- Enum VALUES removed at the TS/schema layer (activity_operation:
-- 'password_change'; security_event_type: 'auth.password.changed',
-- 'auth.password.reset.requested', 'auth.password.reset.completed').
-- Writer-side type safety is preserved via the TS ActivityOperation and
-- SecurityEventType string-literal unions.

ALTER TABLE "activity_logs"
  ALTER COLUMN "operation" TYPE text USING "operation"::text;--> statement-breakpoint

ALTER TABLE "activity_logs"
  ALTER COLUMN "rollbackSourceOperation" TYPE text USING "rollbackSourceOperation"::text;--> statement-breakpoint

DROP TYPE "activity_operation";--> statement-breakpoint

ALTER TABLE "security_audit_log"
  ALTER COLUMN "event_type" TYPE text USING "event_type"::text;--> statement-breakpoint

DROP TYPE "security_event_type";
