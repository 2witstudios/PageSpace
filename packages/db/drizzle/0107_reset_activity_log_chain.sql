-- 0107: Reset activity_logs hash chain (PII exclusion)
--
-- The old hash algorithm included userId and actorEmail in each entry's hash.
-- When a user is deleted (userId → null, actorEmail → anonymized), those hashes
-- become unverifiable — breaking tamper-evidence for the whole chain.
-- Additionally, a race condition (Apr 14-22 2026, now fixed with advisory locks)
-- produced forked chain entries. Nulling these fields lets the next logActivity()
-- call seed a fresh PII-free chain from a clean state.
-- Idempotent: WHERE clause is a no-op if the chain is already clean.

UPDATE activity_logs
SET "logHash" = NULL, "previousLogHash" = NULL, "chainSeed" = NULL
WHERE "logHash" IS NOT NULL;
