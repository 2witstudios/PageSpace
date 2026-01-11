-- Token Hash Migration Script
-- Run directly against the production database
-- Requires: pgcrypto extension (usually pre-installed on managed PostgreSQL)

-- Enable pgcrypto if not already enabled
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Migrate refresh_tokens
UPDATE refresh_tokens
SET
  "tokenHash" = encode(digest(token, 'sha256'), 'hex'),
  "tokenPrefix" = substring(token, 1, 12)
WHERE "tokenHash" IS NULL AND token IS NOT NULL;

-- Migrate mcp_tokens
UPDATE mcp_tokens
SET
  "tokenHash" = encode(digest(token, 'sha256'), 'hex'),
  "tokenPrefix" = substring(token, 1, 12)
WHERE "tokenHash" IS NULL AND token IS NOT NULL;

-- Migrate device_tokens
UPDATE device_tokens
SET
  "tokenHash" = encode(digest(token, 'sha256'), 'hex'),
  "tokenPrefix" = substring(token, 1, 12)
WHERE "tokenHash" IS NULL AND token IS NOT NULL;

-- Migrate verification_tokens
UPDATE verification_tokens
SET
  "tokenHash" = encode(digest(token, 'sha256'), 'hex'),
  "tokenPrefix" = substring(token, 1, 12)
WHERE "tokenHash" IS NULL AND token IS NOT NULL;

-- Verification query - run after migration
SELECT
  'refresh_tokens' as table_name,
  COUNT(*) as total,
  COUNT("tokenHash") as with_hash,
  COUNT(*) - COUNT("tokenHash") as without_hash
FROM refresh_tokens
UNION ALL
SELECT
  'mcp_tokens',
  COUNT(*),
  COUNT("tokenHash"),
  COUNT(*) - COUNT("tokenHash")
FROM mcp_tokens
UNION ALL
SELECT
  'device_tokens',
  COUNT(*),
  COUNT("tokenHash"),
  COUNT(*) - COUNT("tokenHash")
FROM device_tokens
UNION ALL
SELECT
  'verification_tokens',
  COUNT(*),
  COUNT("tokenHash"),
  COUNT(*) - COUNT("tokenHash")
FROM verification_tokens;
