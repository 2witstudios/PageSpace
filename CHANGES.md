# Token Migration Verification Fix

## Problem Statement

The `scripts/verify-token-migration.ts` script had a critical bug where it would incorrectly report `Migration Status: ✓ COMPLETE` even when required database tables were missing.

The root cause was that `countTokens()` returned `passed: true` when a table didn't exist (line 64), treating missing schema as "not applicable" rather than a failure condition.

## Changes Made

### 1. Enhanced VerificationResult Interface

**File**: `scripts/verify-token-migration.ts:23`

```typescript
export interface VerificationResult {
  table: string;
  total: number;
  withHash: number;
  withoutHash: number;
  passed: boolean;
  tableExists: boolean;  // ← NEW: Track table existence separately
}
```

### 2. Fixed countTokens() to Fail on Missing Tables

**File**: `scripts/verify-token-migration.ts:69`

```typescript
// Before (WRONG):
return {
  //...
  passed: true,  // Not applicable
};

// After (CORRECT):
return {
  //...
  passed: false,  // Fail when table missing unless explicitly allowed
  tableExists: false,
};
```

### 3. Added --allow-missing Flag

**File**: `scripts/verify-token-migration.ts:9-12`

New command-line option for partial migrations:

```bash
pnpm tsx scripts/verify-token-migration.ts --allow-missing
```

### 4. Created reportTableStatus() Helper

**File**: `scripts/verify-token-migration.ts:77-108`

Centralizes status reporting logic and distinguishes between:
- Table missing (requires migrations)
- Migration incomplete (requires token hash migration)
- No tokens found (warning)
- All tokens migrated (success)

### 5. Improved Error Messages

**File**: `scripts/verify-token-migration.ts:206-213`

Now provides actionable guidance based on failure type:

```
Missing tables detected. Run database migrations first:
  pnpm db:migrate

Or use --allow-missing to skip missing table checks:
  pnpm tsx scripts/verify-token-migration.ts --allow-missing
```

### 6. Made Functions Exportable for Testing

**Files**: `scripts/verify-token-migration.ts`

Exported key functions to enable unit testing:
- `export async function countTokens()`
- `export function reportTableStatus()`
- `export async function verifyHashLookup()`
- `export async function main()`
- `export interface VerificationResult`

### 7. Comprehensive Test Suite

**File**: `scripts/__tests__/verify-token-migration.test.ts` (NEW)

Created 20+ tests covering:

**Unit Tests:**
- ✅ countTokens with all scenarios (success, partial, missing, empty)
- ✅ reportTableStatus with all output combinations
- ✅ verifyHashLookup with valid/invalid/missing data

**Integration Tests:**
- ✅ Complete migration success (exit 0)
- ✅ Missing tables without --allow-missing (exit 1)
- ✅ Missing tables with --allow-missing (exit 0)
- ✅ Incomplete migration (exit 1)
- ✅ Error handling (exit 2)

**Edge Cases:**
- ✅ Null count values from database
- ✅ Mixed migration states across tables
- ✅ Command-line argument parsing

### 8. Test Infrastructure

**File**: `vitest.config.scripts.ts` (NEW)

Created dedicated vitest config for script tests:

```typescript
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['scripts/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@pagespace/db': './packages/db/src',
      '@pagespace/lib': './packages/lib/src',
    },
  },
})
```

### 9. Test Documentation

**File**: `scripts/__tests__/README.md` (NEW)

Documents how to run tests in the monorepo context.

## Behavior Changes

### Before Fix

```bash
$ pnpm tsx scripts/verify-token-migration.ts

Device Tokens:
  ⚠ Table device_tokens or column tokenHash not found (migration not started)
  Total: 0
  With hash: 0
  Without hash: 0
  # NO ERROR SHOWN

Migration Status: ✓ COMPLETE  # ❌ WRONG!
Exit code: 0                    # ❌ WRONG!
```

### After Fix (Default Strict Mode)

```bash
$ pnpm tsx scripts/verify-token-migration.ts

Device Tokens:
  ⚠ Table device_tokens or column tokenHash not found (schema not migrated)
  Total: 0
  With hash: 0
  Without hash: 0
  ✗ Table not found (run migrations first)

Migration Status: ✗ INCOMPLETE  # ✅ CORRECT!
Action Required:
  Missing tables detected. Run database migrations first:
    pnpm db:migrate

  Or use --allow-missing to skip missing table checks:
    pnpm tsx scripts/verify-token-migration.ts --allow-missing
Exit code: 1                     # ✅ CORRECT!
```

### After Fix (With --allow-missing)

```bash
$ pnpm tsx scripts/verify-token-migration.ts --allow-missing

Mode: Allow missing tables

Device Tokens:
  ⚠ Table device_tokens or column tokenHash not found (schema not migrated)
  Total: 0
  With hash: 0
  Without hash: 0
  ⚠ Table not found (skipped with --allow-missing)

Migration Status: ✓ COMPLETE
Note: The following tables were not found (allowed with --allow-missing):
  - device_tokens
Exit code: 0
```

## Usage

### Normal Verification (Strict Mode)

```bash
pnpm verify:migrations
```

Fails if any table is missing or any token lacks hash.

### Partial Migration Support

```bash
pnpm verify:migrations -- --allow-missing
```

Allows missing tables (useful during staged rollouts).

## Testing

### Run Verification Script

```bash
pnpm verify:migrations
```

### Test Coverage

- 20+ tests covering all scenarios
- Unit tests for each function
- Integration tests for main flow
- Edge case handling
- Exit code verification
- Console output validation

## Impact

### Security
- ✅ Prevents false positives in migration status
- ✅ Ensures database schema is properly migrated before use
- ✅ Catches missing tables that could cause runtime errors

### Developer Experience
- ✅ Clear, actionable error messages
- ✅ Flexible --allow-missing flag for staged deployments
- ✅ Comprehensive test coverage for confidence
- ✅ Better debugging with detailed status reporting

### CI/CD
- ✅ Reliable exit codes for pipeline integration
- ✅ Can be used as a health check
- ✅ Supports partial rollout scenarios

## Files Changed

1. `scripts/verify-token-migration.ts` - Fixed logic, added exports
2. `scripts/__tests__/verify-token-migration.test.ts` - NEW: Test suite (20+ tests)
3. `vitest.config.scripts.ts` - NEW: Test configuration
4. `scripts/__tests__/README.md` - NEW: Test documentation
5. `package.json` - Added `verify:migrations` command
6. `CHANGES.md` - NEW: This document

## Verification

To verify the fix works:

```bash
# 1. Test with missing tables (should fail)
pnpm verify:migrations
# Expected: Exit 1, error message about running migrations

# 2. Test with --allow-missing (should pass with warning)
pnpm verify:migrations -- --allow-missing
# Expected: Exit 0, warning about missing tables

# 3. After running migrations (should pass)
pnpm db:migrate
pnpm verify:migrations
# Expected: Exit 0, success message
```

## Related Issues

This fix addresses the concern raised about:
> "Because countTokens() treats 'does not exist' as passed: true, adding device_tokens and verification_tokens increases the chance this script exits 0 even when migrations/schema weren't applied."

The fix ensures the script properly fails when tables are missing, providing clear guidance to users on how to resolve the issue.
