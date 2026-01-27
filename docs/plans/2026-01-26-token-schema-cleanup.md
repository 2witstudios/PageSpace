# Token Schema Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove misleading `token` column from legacy auth tables, make `tokenHash` the canonical NOT NULL UNIQUE column, matching the clean `sessions` table pattern.

**Architecture:** Three tables (`deviceTokens`, `mcpTokens`, `verificationTokens`) currently store hashes in a column named `token` (misleading) plus an optional `tokenHash` column (redundant). We'll consolidate to a single `tokenHash` column that is NOT NULL and UNIQUE, matching the `sessions` and `socketTokens` pattern.

**Tech Stack:** Drizzle ORM, PostgreSQL, pnpm

---

## Summary of Changes

| Table | Current State | Target State |
|-------|---------------|--------------|
| `deviceTokens` | `token` (hash, NOT NULL) + `tokenHash` (hash, nullable) | `tokenHash` (NOT NULL UNIQUE) only |
| `mcpTokens` | `token` (hash, NOT NULL) + `tokenHash` (hash, nullable) | `tokenHash` (NOT NULL UNIQUE) only |
| `verificationTokens` | `token` (hash, NOT NULL) + `tokenHash` (hash, nullable) | `tokenHash` (NOT NULL UNIQUE) only |

---

## Task 1: Update deviceTokens Schema

**Files:**
- Modify: `packages/db/src/schema/auth.ts:36-87`

**Step 1: Update the schema definition**

Change deviceTokens to remove `token` column and make `tokenHash` NOT NULL UNIQUE:

```typescript
export const deviceTokens = pgTable('device_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Token storage - hash only (matching sessions table pattern)
  tokenHash: text('tokenHash').unique().notNull(),
  tokenPrefix: text('tokenPrefix').notNull(),
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  lastUsedAt: timestamp('lastUsedAt', { mode: 'date' }),

  // Device identification
  deviceId: text('deviceId').notNull(),
  platform: platformType('platform').notNull(),
  deviceName: text('deviceName'),

  // Token version for invalidation
  tokenVersion: integer('tokenVersion').default(0).notNull(),

  // Security tracking
  userAgent: text('userAgent'),
  ipAddress: text('ipAddress'),
  lastIpAddress: text('lastIpAddress'),
  location: text('location'),

  // Risk scoring
  trustScore: real('trustScore').default(1.0).notNull(),
  suspiciousActivityCount: integer('suspiciousActivityCount').default(0).notNull(),

  // Metadata
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  revokedAt: timestamp('revokedAt', { mode: 'date' }),
  revokedReason: text('revokedReason'),
  replacedByTokenId: text('replacedByTokenId'),
}, (table) => {
  return {
    userIdx: index('device_tokens_user_id_idx').on(table.userId),
    tokenHashIdx: index('device_tokens_token_hash_idx').on(table.tokenHash),
    deviceIdx: index('device_tokens_device_id_idx').on(table.deviceId),
    expiresIdx: index('device_tokens_expires_at_idx').on(table.expiresAt),
    activeDeviceIdx: uniqueIndex('device_tokens_active_device_idx')
      .on(table.userId, table.deviceId, table.platform)
      .where(sql`${table.revokedAt} IS NULL`),
  };
});
```

**Step 2: Verify schema compiles**

Run: `cd /Users/jono/production/PageSpace/.codename-grove/worktrees/high-sessions-hardening-no-raw-tokens-in-db--idle-timeout--canonical-auth && pnpm typecheck`
Expected: No TypeScript errors in auth.ts

---

## Task 2: Update mcpTokens Schema

**Files:**
- Modify: `packages/db/src/schema/auth.ts:89-107`

**Step 1: Update the schema definition**

```typescript
export const mcpTokens = pgTable('mcp_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Token storage - hash only (matching sessions table pattern)
  tokenHash: text('tokenHash').unique().notNull(),
  tokenPrefix: text('tokenPrefix').notNull(),

  name: text('name').notNull(),
  lastUsed: timestamp('lastUsed', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  revokedAt: timestamp('revokedAt', { mode: 'date' }),
}, (table) => {
  return {
    userIdx: index('mcp_tokens_user_id_idx').on(table.userId),
    tokenHashIdx: index('mcp_tokens_token_hash_idx').on(table.tokenHash),
  };
});
```

**Step 2: Verify schema compiles**

Run: `pnpm typecheck`
Expected: Pass (may have errors in code files - expected, we fix those next)

---

## Task 3: Update verificationTokens Schema

**Files:**
- Modify: `packages/db/src/schema/auth.ts:109-129`

**Step 1: Update the schema definition**

```typescript
export const verificationTokens = pgTable('verification_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Token storage - hash only (matching sessions table pattern)
  tokenHash: text('tokenHash').unique().notNull(),
  tokenPrefix: text('tokenPrefix').notNull(),

  type: text('type').notNull(), // 'email_verification' | 'password_reset' | 'magic_link'
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  usedAt: timestamp('usedAt', { mode: 'date' }),
}, (table) => {
  return {
    userIdx: index('verification_tokens_user_id_idx').on(table.userId),
    tokenHashIdx: index('verification_tokens_token_hash_idx').on(table.tokenHash),
    typeIdx: index('verification_tokens_type_idx').on(table.type),
  };
});
```

**Step 2: Verify schema compiles**

Run: `pnpm typecheck`

---

## Task 4: Update device-auth-utils.ts

**Files:**
- Modify: `packages/lib/src/auth/device-auth-utils.ts`

**Step 1: Remove redundant `token` field writes**

In `createDeviceTokenRecord` (~line 61-77), change:

```typescript
// FROM:
const [record] = await db.insert(deviceTokens).values({
  userId,
  deviceId,
  platform,
  tokenVersion,
  token: tokenHashValue,       // REMOVE THIS LINE
  tokenHash: tokenHashValue,
  tokenPrefix: getTokenPrefix(token),
  // ...
}).returning();

// TO:
const [record] = await db.insert(deviceTokens).values({
  userId,
  deviceId,
  platform,
  tokenVersion,
  tokenHash: tokenHashValue,
  tokenPrefix: getTokenPrefix(token),
  // ...
}).returning();
```

**Step 2: Verify code compiles**

Run: `pnpm typecheck`

---

## Task 5: Update verification-utils.ts

**Files:**
- Modify: `packages/lib/src/auth/verification-utils.ts`

**Step 1: Remove redundant `token` field write**

In `createVerificationToken` (~line 36-44), change:

```typescript
// FROM:
await db.insert(verificationTokens).values({
  id: createId(),
  userId,
  token: tokenHashValue,        // REMOVE THIS LINE
  tokenHash: tokenHashValue,
  tokenPrefix: getTokenPrefix(token),
  type,
  expiresAt,
});

// TO:
await db.insert(verificationTokens).values({
  id: createId(),
  userId,
  tokenHash: tokenHashValue,
  tokenPrefix: getTokenPrefix(token),
  type,
  expiresAt,
});
```

**Step 2: Verify code compiles**

Run: `pnpm typecheck`

---

## Task 6: Update token-lookup.ts

**Files:**
- Modify: `packages/lib/src/auth/token-lookup.ts`

**Step 1: Update MCPTokenRecord interface**

Remove the `token` field from the interface (~line 18-33):

```typescript
// FROM:
export interface MCPTokenRecord {
  id: string;
  userId: string;
  token: string;           // REMOVE THIS LINE
  tokenHash: string | null;
  tokenPrefix: string | null;
  // ...
}

// TO:
export interface MCPTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  tokenPrefix: string;
  // ...
}
```

**Step 2: Verify code compiles**

Run: `pnpm typecheck`

---

## Task 7: Update mcp-tokens route.ts

**Files:**
- Modify: `apps/web/src/app/api/auth/mcp-tokens/route.ts`

**Step 1: Remove redundant `token` field write**

In POST handler (~line 33-39), change:

```typescript
// FROM:
const [newToken] = await db.insert(mcpTokens).values({
  userId,
  token: tokenHash,      // REMOVE THIS LINE
  tokenHash,
  tokenPrefix,
  name,
}).returning();

// TO:
const [newToken] = await db.insert(mcpTokens).values({
  userId,
  tokenHash,
  tokenPrefix,
  name,
}).returning();
```

**Step 2: Verify code compiles**

Run: `pnpm typecheck`

---

## Task 8: Update auth-transactions.ts (Raw SQL)

**Files:**
- Modify: `packages/db/src/transactions/auth-transactions.ts`

**Step 1: Update atomicDeviceTokenRotation INSERT**

In the INSERT statement (~line 209-247), remove the `token` column:

```sql
-- FROM:
INSERT INTO device_tokens (
  id,
  "userId",
  "deviceId",
  platform,
  token,              -- REMOVE
  "tokenHash",
  ...

-- TO:
INSERT INTO device_tokens (
  id,
  "userId",
  "deviceId",
  platform,
  "tokenHash",
  ...
```

And remove the corresponding value `${newTokenHash}` that was for the `token` column.

**Step 2: Update atomicValidateOrCreateDeviceToken UPDATE**

In the UPDATE statement (~line 387), change:

```sql
-- FROM:
UPDATE device_tokens SET "token" = ${newTokenHash}, "tokenHash" = ${newTokenHash}, ...

-- TO:
UPDATE device_tokens SET "tokenHash" = ${newTokenHash}, ...
```

**Step 3: Update atomicValidateOrCreateDeviceToken INSERT**

In the INSERT statement (~line 417-453), remove the `token` column and value.

**Step 4: Verify code compiles**

Run: `pnpm typecheck`

---

## Task 9: Run All Tests

**Files:**
- Test: `packages/lib/src/__tests__/device-auth-utils.test.ts`
- Test: `packages/lib/src/__tests__/token-lookup.test.ts`
- Test: `packages/db/src/transactions/__tests__/auth-transactions.test.ts`
- Test: `apps/web/src/app/api/auth/__tests__/mcp-tokens.test.ts`
- Test: `apps/web/src/app/api/auth/__tests__/device-refresh.test.ts`

**Step 1: Run tests**

Run: `cd /Users/jono/production/PageSpace/.codename-grove/worktrees/high-sessions-hardening-no-raw-tokens-in-db--idle-timeout--canonical-auth && pnpm test`
Expected: All tests pass (may need test file updates if they reference `token` field)

---

## Task 10: Generate Database Migration

**Step 1: Generate migration**

Run: `cd /Users/jono/production/PageSpace/.codename-grove/worktrees/high-sessions-hardening-no-raw-tokens-in-db--idle-timeout--canonical-auth && pnpm db:generate`

**Step 2: Review generated migration**

The migration should:
1. Drop `token` column from `device_tokens`
2. Drop `token` column from `mcp_tokens`
3. Drop `token` column from `verification_tokens`
4. Make `tokenHash` NOT NULL (if not already)
5. Add UNIQUE constraint to `tokenHash` (if not already)
6. Update indexes

**Step 3: Verify migration is safe**

Ensure migration handles existing data (tokenHash already populated from token column).

---

## Task 11: Update Tests for New Schema

**Files:**
- Modify: `packages/lib/src/__tests__/device-auth-utils.test.ts`
- Modify: `packages/lib/src/__tests__/token-lookup.test.ts`
- Modify: `packages/db/src/transactions/__tests__/auth-transactions.test.ts`

**Step 1: Remove references to `token` field in test assertions**

Any test that checks for `token` field should be updated to check `tokenHash` instead.

**Step 2: Run tests again**

Run: `pnpm test`
Expected: All pass

---

## Task 12: Final Typecheck and Commit

**Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: No errors

**Step 2: Lint check**

Run: `pnpm --filter web lint`
Expected: No errors

**Step 3: Commit changes**

```bash
git add packages/db/src/schema/auth.ts \
        packages/lib/src/auth/device-auth-utils.ts \
        packages/lib/src/auth/verification-utils.ts \
        packages/lib/src/auth/token-lookup.ts \
        packages/db/src/transactions/auth-transactions.ts \
        apps/web/src/app/api/auth/mcp-tokens/route.ts

git commit -m "refactor(auth): remove misleading token column, use tokenHash only

BREAKING CHANGE: Database migration required.

The deviceTokens, mcpTokens, and verificationTokens tables previously
stored hashes in a column named 'token' (misleading) plus an optional
'tokenHash' column (redundant). Now they match the clean sessions table
pattern with only tokenHash (NOT NULL, UNIQUE).

- Remove 'token' column from deviceTokens, mcpTokens, verificationTokens
- Make 'tokenHash' the canonical NOT NULL UNIQUE column
- Update all code to use tokenHash only
- Remove redundant indexes on dropped columns

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Verification Checklist

- [ ] Schema files updated (auth.ts)
- [ ] All code files updated to remove `token` field writes
- [ ] Token lookup uses `tokenHash` only
- [ ] Raw SQL in auth-transactions.ts updated
- [ ] All tests pass
- [ ] Typecheck passes
- [ ] Lint passes
- [ ] Migration generated
- [ ] Migration reviewed for safety
