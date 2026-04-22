-- 0106: Backfill SHA-256 token hashes (security)
--
-- Before Jan 2026, session/auth tokens were stored in plaintext. The hash-at-rest
-- implementation added tokenHash + tokenPrefix columns but left existing rows with
-- NULL hashes. This migration backfills those hashes so all tokens are secured.
-- Idempotent: WHERE clause skips rows that already have a hash.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
UPDATE refresh_tokens
SET
  "tokenHash" = encode(digest(token, 'sha256'), 'hex'),
  "tokenPrefix" = substring(token, 1, 12)
WHERE "tokenHash" IS NULL AND token IS NOT NULL;
--> statement-breakpoint
UPDATE mcp_tokens
SET
  "tokenHash" = encode(digest(token, 'sha256'), 'hex'),
  "tokenPrefix" = substring(token, 1, 12)
WHERE "tokenHash" IS NULL AND token IS NOT NULL;
--> statement-breakpoint
UPDATE device_tokens
SET
  "tokenHash" = encode(digest(token, 'sha256'), 'hex'),
  "tokenPrefix" = substring(token, 1, 12)
WHERE "tokenHash" IS NULL AND token IS NOT NULL;
--> statement-breakpoint
UPDATE verification_tokens
SET
  "tokenHash" = encode(digest(token, 'sha256'), 'hex'),
  "tokenPrefix" = substring(token, 1, 12)
WHERE "tokenHash" IS NULL AND token IS NOT NULL;
