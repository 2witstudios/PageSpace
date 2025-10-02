# PageSpace Test Suite - Remaining Failures

**Status**: 404 / 414 tests passing (97.6% pass rate) ✅
**Last Updated**: 2025-10-02
**Remaining Failures**: 10 tests across 4 files

---

## How the Test Suite Works

### Running Tests

Tests MUST be run inside Docker to access the PostgreSQL database:

```bash
# Run all tests
docker compose --profile test run --rm test

# Run specific test file
docker compose --profile test run --rm test -- src/__tests__/encryption-utils.test.ts
```

**Important**: Tests will fail if run on the host machine (`pnpm test`) because PostgreSQL is on an internal Docker network for security.

### Test Architecture

- **Database Cleanup**: Each test file uses `TRUNCATE TABLE users CASCADE` in `beforeEach` to ensure clean state
- **Sequential Execution**: Tests run with `fileParallelism: false` to avoid race conditions with database cleanup
- **Environment Setup**: `packages/lib/src/__tests__/setup.ts` provides test environment variables (JWT secrets, encryption keys, etc.)
- **Test Factories**: `packages/db/src/test/factories.ts` provides helpers to create test users, drives, pages, etc.

### Key Configuration

- **Test Config**: `packages/lib/vitest.config.ts`
- **Docker Setup**: `docker-compose.yml` (see `test` service, lines 207-234)
- **Database**: PostgreSQL in Docker container `pagespace-postgres-1` with test database `pagespace_test`

---

## Remaining 10 Test Failures

### 1. Encryption Utils (1 failure)

**File**: `packages/lib/src/__tests__/encryption-utils.test.ts`
**Test**: `encryption-utils > decrypt > throws error for corrupted auth tag`
**Line**: 136

**Issue**: The test corrupts the authentication tag but `decrypt()` still succeeds instead of throwing an error.

```typescript
// Expected: decrypt() should reject with 'Decryption failed'
// Actual: decrypt() resolves with 'sensitive-api-key-12345'
```

**Where to Fix**: `packages/lib/src/encryption-utils.ts` - The `decrypt()` function needs to properly validate the auth tag before attempting decryption.

**Root Cause**: GCM authentication tag validation is not working correctly. The decipher should throw when the auth tag is invalid.

---

### 2. Page Content Parser (3 failures)

**File**: `packages/lib/src/__tests__/page-content-parser.test.ts`

#### 2.1 SHEET Parsing Error Handling

**Test**: `page-content-parser > getPageContentForAI > SHEET type > handles sheet parsing error`
**Line**: 236

**Issue**: When sheet content is invalid JSON, the parser should return an error message but instead returns a default empty sheet.

```typescript
// Expected: result.toContain('Failed to parse sheet content')
// Actual: Returns formatted empty 20x10 sheet
```

**Where to Fix**: `packages/lib/src/page-content-parser.ts` - The SHEET parsing logic needs better error handling for malformed JSON.

---

#### 2.2 Empty String Content

**Test**: `page-content-parser > getPageContentForAI > edge cases > handles empty string content`
**Line**: 420

**Issue**: Empty string (`""`) should be treated as intentionally empty content, not missing content.

```typescript
// Expected: Should NOT show "No document content available"
// Actual: Shows "No document content available."
```

**Where to Fix**: `packages/lib/src/page-content-parser.ts` - Update the DOCUMENT handler to distinguish between `null`/`undefined` (missing) vs `""` (empty but present).

**Suggested Fix**:
```typescript
if (content === null || content === undefined) {
  return 'No document content available.'
}
// Empty string is valid - return it as-is
```

---

#### 2.3 CANVAS Type Support

**Test**: `page-content-parser > getPageContentForAI > all page types coverage > handles CANVAS type`
**Line**: 475

**Issue**: CANVAS content extraction is not implemented.

```typescript
// Expected: result.toContain('<div>HTML content</div>')
// Actual: "Content extraction not implemented for page type: CANVAS"
```

**Where to Fix**: `packages/lib/src/page-content-parser.ts` - Add CANVAS case to the switch statement to handle HTML content like DOCUMENT.

**Suggested Implementation**:
```typescript
case PageType.CANVAS:
  return page.content || 'No canvas content available.'
```

---

### 3. Page Type Validators (3 failures)

**File**: `packages/lib/src/__tests__/page-type-validators.test.ts`

#### 3.1 & 3.2 SHEET Content Validation

**Tests**:
- `validatePageCreation > rejects SHEET with invalid content` (line 137)
- `validatePageUpdate > rejects invalid sheet content for SHEET` (line 247)

**Issue**: SHEET validation accepts invalid JSON instead of rejecting it.

```typescript
// Expected: result.valid = false with error 'Invalid sheet content'
// Actual: result.valid = true (accepts invalid JSON)
```

**Where to Fix**: `packages/lib/src/page-type-validators.ts` - Both `validatePageCreation` and `validatePageUpdate` need stricter SHEET content validation.

**Current Behavior**: Validation passes for any string content
**Expected Behavior**: Should validate that content is valid JSON with correct sheet structure

**Suggested Fix**:
```typescript
if (type === PageType.SHEET && data.content) {
  try {
    const parsed = JSON.parse(data.content)
    if (!parsed.cells || !Array.isArray(parsed.cells)) {
      errors.push('Invalid sheet content: must have cells array')
      valid = false
    }
  } catch (e) {
    errors.push('Invalid sheet content: must be valid JSON')
    valid = false
  }
}
```

---

#### 3.3 Missing Function Export

**Tests**:
- `pageTypeRequiresAuth > returns true for AI_CHAT` (line 397)
- `pageTypeRequiresAuth > returns true for DOCUMENT` (line 402)
- `pageTypeRequiresAuth > returns true for all page types` (line 418)

**Issue**: `pageTypeRequiresAuth` function is not exported from the module.

```typescript
// Error: TypeError: pageTypeRequiresAuth is not a function
```

**Where to Fix**: `packages/lib/src/page-type-validators.ts` - Add export for `pageTypeRequiresAuth` function

**Suggested Fix**:
```typescript
export function pageTypeRequiresAuth(type: PageType): boolean {
  // All page types currently require authentication
  return true
}
```

---

### 4. Tree Utils (1 failure)

**File**: `packages/lib/src/__tests__/tree-utils.test.ts`
**Test**: `tree-utils > buildTree > handles duplicate IDs gracefully (last one wins)`
**Line**: 203

**Issue**: When duplicate page IDs exist, both entries appear in the tree instead of keeping only the last one.

```typescript
// Expected: tree.length = 1 (last duplicate wins)
// Actual: tree.length = 2 (both duplicates present)
```

**Where to Fix**: `packages/lib/src/tree-utils.ts` - The `buildTree()` function needs to deduplicate entries using a Map before building the tree.

**Root Cause**: The function currently processes all pages linearly without checking for duplicate IDs.

**Suggested Fix**:
```typescript
export function buildTree(pages: Page[]): TreeNode[] {
  // Deduplicate by ID - last one wins
  const pageMap = new Map<string, Page>()
  pages.forEach(page => pageMap.set(page.id, page))
  const uniquePages = Array.from(pageMap.values())

  // Continue with existing tree building logic...
}
```

---

## Testing Workflow for Fixes

1. **Rebuild Docker image** after making changes:
   ```bash
   docker compose --profile test build test
   ```

2. **Run specific test file** to verify fix:
   ```bash
   docker compose --profile test run --rm test -- src/__tests__/encryption-utils.test.ts
   ```

3. **Run full suite** to ensure no regressions:
   ```bash
   docker compose --profile test run --rm test
   ```

---

## Summary of Issues

| Category | Files to Fix | Issue Type |
|----------|-------------|------------|
| Security | `encryption-utils.ts` | Auth tag validation not enforcing integrity |
| Content Parsing | `page-content-parser.ts` | Missing CANVAS support, incorrect empty string handling, poor SHEET error handling |
| Validation | `page-type-validators.ts` | Missing SHEET JSON validation, missing function export |
| Tree Building | `tree-utils.ts` | No deduplication for duplicate IDs |

**Priority**:
1. 🔴 **High**: Encryption auth tag validation (security issue)
2. 🟡 **Medium**: Page type validators (data integrity)
3. 🟢 **Low**: Content parser edge cases, tree utils deduplication
