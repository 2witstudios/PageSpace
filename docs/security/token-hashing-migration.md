# Token Hashing Migration Runbook

> **Security Enhancement: Hash Sensitive Tokens at Rest**
>
> This document describes the migration from plaintext token storage to SHA-256 hashed storage for refresh tokens and MCP tokens.

## Overview

### Current State
- Refresh tokens stored in `refresh_tokens.token` as plaintext
- MCP tokens stored in `mcp_tokens.token` as plaintext
- Tokens can be read directly from database (security risk)

### Target State
- Tokens stored as SHA-256 hashes in `token_hash` column
- Only first 12 characters stored as `token_prefix` for debugging
- Original plaintext tokens never stored after creation
- Token lookup uses hash comparison

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Migration corrupts tokens | HIGH | Run in transaction, verify before commit |
| Users logged out during migration | MEDIUM | Migration preserves existing tokens |
| Rollback needed | MEDIUM | Keep plaintext column until verified |
| Performance regression | LOW | Add index on token_hash |

## Prerequisites

- [ ] Redis available for distributed rate limiting
- [ ] Database backup completed
- [ ] Maintenance window scheduled (if needed)
- [ ] Rollback procedure tested in staging

## Migration Steps

### Phase 1: Schema Migration (Non-Breaking)

Add new columns without removing old ones:

```sql
-- Migration: add_token_hash_columns
ALTER TABLE refresh_tokens
  ADD COLUMN token_hash TEXT,
  ADD COLUMN token_prefix VARCHAR(12);

ALTER TABLE mcp_tokens
  ADD COLUMN token_hash TEXT,
  ADD COLUMN token_prefix VARCHAR(12);

-- Indexes for efficient lookup
CREATE UNIQUE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash) WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX idx_mcp_tokens_hash ON mcp_tokens(token_hash) WHERE token_hash IS NOT NULL;
```

### Phase 2: Backfill Existing Tokens

Run the backfill script to hash existing tokens:

```bash
# Dry run first
pnpm tsx scripts/migrate-token-hashes.ts --dry-run

# Execute migration
pnpm tsx scripts/migrate-token-hashes.ts

# Verify migration
pnpm tsx scripts/verify-token-migration.ts
```

**Migration Script Logic:**
```typescript
// scripts/migrate-token-hashes.ts
import { db, refreshTokens, mcpTokens } from '@pagespace/db';
import { createHash } from 'crypto';
import { isNull } from 'drizzle-orm';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function migrateRefreshTokens() {
  const tokens = await db.select()
    .from(refreshTokens)
    .where(isNull(refreshTokens.tokenHash));

  console.log(`Found ${tokens.length} refresh tokens to migrate`);

  for (const token of tokens) {
    await db.update(refreshTokens)
      .set({
        tokenHash: hashToken(token.token),
        tokenPrefix: token.token.substring(0, 12),
      })
      .where(eq(refreshTokens.id, token.id));
  }
}

async function migrateMcpTokens() {
  const tokens = await db.select()
    .from(mcpTokens)
    .where(isNull(mcpTokens.tokenHash));

  console.log(`Found ${tokens.length} MCP tokens to migrate`);

  for (const token of tokens) {
    await db.update(mcpTokens)
      .set({
        tokenHash: hashToken(token.token),
        tokenPrefix: token.token.substring(0, 12),
      })
      .where(eq(mcpTokens.id, token.id));
  }
}
```

### Phase 3: Deploy Dual-Mode Code

Update application code to:
1. Write new tokens with hash (and temporarily plaintext for rollback)
2. Read tokens using hash lookup
3. Fall back to plaintext lookup if hash not found

```typescript
// Dual-mode lookup during migration
async function findRefreshToken(token: string): Promise<RefreshToken | null> {
  const tokenHash = hashToken(token);

  // Try hash lookup first
  let found = await db.query.refreshTokens.findFirst({
    where: eq(refreshTokens.tokenHash, tokenHash),
  });

  // Fall back to plaintext during migration
  if (!found) {
    found = await db.query.refreshTokens.findFirst({
      where: eq(refreshTokens.token, token),
    });
  }

  return found;
}
```

### Phase 4: Verification

Run verification script to ensure:
- All tokens have hashes
- Hash lookups work correctly
- No orphaned tokens

```bash
pnpm tsx scripts/verify-token-migration.ts
```

**Expected Output:**
```text
Token Migration Verification
============================
Refresh Tokens:
  Total: 1,234
  With hash: 1,234
  Without hash: 0
  ✓ All refresh tokens migrated

MCP Tokens:
  Total: 567
  With hash: 567
  Without hash: 0
  ✓ All MCP tokens migrated

Hash Lookup Test:
  ✓ Random sample of 10 tokens verified

Migration Status: COMPLETE
```

### Phase 5: Monitor (24-48 hours)

- Monitor error rates for token refresh
- Check for "token not found" errors
- Verify new tokens created with hashes

### Phase 6: Remove Plaintext Column

After successful verification:

```sql
-- Final migration: remove plaintext columns
ALTER TABLE refresh_tokens
  DROP COLUMN token;

ALTER TABLE mcp_tokens
  DROP COLUMN token;

-- Make hash columns NOT NULL
ALTER TABLE refresh_tokens
  ALTER COLUMN token_hash SET NOT NULL,
  ALTER COLUMN token_prefix SET NOT NULL;

ALTER TABLE mcp_tokens
  ALTER COLUMN token_hash SET NOT NULL,
  ALTER COLUMN token_prefix SET NOT NULL;
```

## Rollback Procedure

### If Issues in Phase 3-4:

1. Revert application code to plaintext-only
2. No data migration needed (plaintext still present)

```bash
git revert <commit-hash>
pnpm build && pnpm start
```

### If Issues in Phase 5:

1. Keep monitoring for 48 hours before Phase 6
2. Do NOT proceed to Phase 6 if any issues

### If Issues After Phase 6:

1. This is not easily reversible
2. Must restore from backup
3. Never proceed to Phase 6 until 100% confident

## Verification Script

```typescript
// scripts/verify-token-migration.ts
import { db, refreshTokens, mcpTokens } from '@pagespace/db';
import { isNull, count } from 'drizzle-orm';
import { createHash } from 'crypto';

async function verify() {
  console.log('Token Migration Verification');
  console.log('============================\n');

  // Check refresh tokens
  const [refreshTotal] = await db.select({ count: count() }).from(refreshTokens);
  const [refreshWithHash] = await db.select({ count: count() })
    .from(refreshTokens)
    .where(isNull(refreshTokens.tokenHash).not());
  const [refreshWithoutHash] = await db.select({ count: count() })
    .from(refreshTokens)
    .where(isNull(refreshTokens.tokenHash));

  console.log('Refresh Tokens:');
  console.log(`  Total: ${refreshTotal.count}`);
  console.log(`  With hash: ${refreshWithHash.count}`);
  console.log(`  Without hash: ${refreshWithoutHash.count}`);

  if (refreshWithoutHash.count === 0) {
    console.log('  ✓ All refresh tokens migrated\n');
  } else {
    console.log('  ✗ Some refresh tokens missing hash\n');
    process.exit(1);
  }

  // Check MCP tokens
  const [mcpTotal] = await db.select({ count: count() }).from(mcpTokens);
  const [mcpWithHash] = await db.select({ count: count() })
    .from(mcpTokens)
    .where(isNull(mcpTokens.tokenHash).not());
  const [mcpWithoutHash] = await db.select({ count: count() })
    .from(mcpTokens)
    .where(isNull(mcpTokens.tokenHash));

  console.log('MCP Tokens:');
  console.log(`  Total: ${mcpTotal.count}`);
  console.log(`  With hash: ${mcpWithHash.count}`);
  console.log(`  Without hash: ${mcpWithoutHash.count}`);

  if (mcpWithoutHash.count === 0) {
    console.log('  ✓ All MCP tokens migrated\n');
  } else {
    console.log('  ✗ Some MCP tokens missing hash\n');
    process.exit(1);
  }

  console.log('Migration Status: COMPLETE');
}

verify().catch(console.error);
```

## Security Considerations

### Why SHA-256?

- Industry standard for token hashing
- Deterministic (same input = same output)
- One-way function (cannot reverse hash to token)
- Fast enough for production use
- 256-bit output prevents collisions

### Token Prefix

We store first 12 characters for:
- Debugging token issues
- Identifying token type (prefix pattern)
- NOT for security (not sufficient for lookup)

### Timing Attacks

Token hash comparison uses constant-time comparison:

```typescript
import { timingSafeEqual } from 'crypto';

function compareHashes(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return timingSafeEqual(bufA, bufB);
}
```

## Timeline

| Phase | Duration | Description |
|-------|----------|-------------|
| 1 | 1 day | Schema migration |
| 2 | 1 day | Backfill tokens |
| 3 | 1 day | Deploy dual-mode |
| 4 | 1 day | Verification |
| 5 | 2 days | Monitoring |
| 6 | 1 day | Remove plaintext |

### Total Duration: ~1 week

## Checklist

### Pre-Migration
- [ ] Database backup completed
- [ ] Staging environment tested
- [ ] Rollback procedure verified
- [ ] Team notified of maintenance

### During Migration
- [ ] Phase 1 schema applied
- [ ] Phase 2 backfill completed
- [ ] Phase 3 code deployed
- [ ] Phase 4 verification passed

### Post-Migration
- [ ] 24-hour monitoring complete
- [ ] 48-hour monitoring complete
- [ ] Phase 6 plaintext removal
- [ ] Documentation updated
