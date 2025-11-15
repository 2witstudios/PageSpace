# Audit System Test Suite Documentation

## Overview

Comprehensive test suite for PageSpace's audit trail and versioning system, ensuring production readiness through 150+ tests covering unit, integration, and API testing.

## Test Structure

### 1. Test Factories (`packages/db/src/test/factories.ts`)

**New Factories Added:**
- `createAuditEvent()` - Creates audit event with configurable action types
- `createPageVersion()` - Creates page version snapshots
- `createAiOperation()` - Creates AI operation tracking records

These factories support test isolation and provide consistent test data generation.

### 2. Unit Tests (`packages/lib/src/__tests__/`)

#### `audit-create-event.test.ts` (40+ tests)

Tests for audit event creation and change tracking:

**Key Test Suites:**
- `createAuditEvent` - Validates event creation with various configurations
  - Basic page update actions with user attribution
  - Before/after state tracking
  - Changes computation
  - AI action attribution with operation IDs
  - Request context (IP, user agent, session)
  - Operation grouping for bulk actions
  - Parent-child event relationships
  - Custom metadata storage
  - Permission and drive events

- `createBulkAuditEvents` - Validates bulk event creation
  - Multiple related events in single transaction
  - Empty array handling
  - Mixed action types

- `computeChanges` - Validates change detection
  - Changed fields detection
  - No changes scenario
  - Added fields handling
  - Removed fields handling
  - Nested objects
  - All fields changed

**Coverage Target:** >85%

#### `audit-page-version.test.ts` (50+ tests)

Tests for page versioning and snapshot management:

**Key Test Suites:**
- `createPageVersion` - Version creation
  - Basic page snapshots
  - Sequential version numbering
  - AI-generated versions
  - Audit event linking
  - Metadata snapshots
  - Content size calculation

- `getPageVersions` - Version retrieval
  - Multiple versions in descending order
  - Limit parameter
  - No versions handling
  - User and audit event relations

- `getPageVersion` - Single version retrieval
- `getLatestPageVersion` - Latest version retrieval
- `comparePageVersions` - Version comparison
- `restorePageVersion` - Version restoration
  - Valid version restoration
  - Audit event creation
  - Error handling

- `getPageVersionStats` - Version statistics
  - AI vs human edit counts
  - Size aggregation
  - Date ranges

**Coverage Target:** >85%

#### `audit-ai-operation.test.ts` (45+ tests)

Tests for AI operation tracking and attribution:

**Key Test Suites:**
- `trackAiOperation` - AI operation lifecycle
  - Basic operation tracking
  - Successful completion
  - Operation failure
  - Cancellation
  - Conversation context
  - Tool usage tracking
  - System prompts
  - Custom metadata

- `getUserAiOperations` - User-scoped operations
- `getDriveAiOperations` - Drive-scoped operations
- `getPageAiOperations` - Page-specific operations
- `getAiUsageReport` - Usage statistics aggregation
- `getConversationAiOperations` - Conversation tracking
- `getLatestAiOperation` - Most recent operation
- `getFailedAiOperations` - Failed operations filtering
- `getAiUsageSummary` - Usage summary with metrics

**Coverage Target:** >85%

#### `audit-query-events.test.ts` (60+ tests)

Tests for audit event querying and activity feeds:

**Key Test Suites:**
- `getAuditEvents` - Flexible event querying
  - No filters (all events)
  - Drive ID filtering
  - User ID filtering
  - Entity type/ID filtering
  - Action type filtering
  - AI action filtering
  - Date range filtering
  - Operation ID filtering
  - Combined filters

- `getDriveActivityFeed` - Drive activity
- `getUserActivityTimeline` - User activity
- `getEntityHistory` - Entity-specific history
- `getDriveAiActivity` - AI-only events
- `getDriveHumanActivity` - Human-only events
- `getOperationEvents` - Grouped operations
- `getMultiDriveActivity` - Cross-drive activity
- `getDriveActivityByDateRange` - Date-ranged activity
- `getDriveActivityStats` - Activity statistics
- `searchAuditEvents` - Text search in descriptions
- `getLatestEntityEvent` - Most recent entity event
- `getEventsByActionType` - Action type filtering
- `getPageAuditEvents` - Page-specific events
- `getPagePermissionEvents` - Permission-related events

**Coverage Target:** >80%

### 3. Integration Tests (`apps/web/src/test/integration/audit/`)

#### `page-versions-api.test.ts` (15+ tests)

Tests for page versions API endpoints:

**GET /api/pages/[pageId]/versions**
- With view permission (200)
- With limit parameter
- Without view permission (403)
- Without authentication (401)
- With non-existent page (403)
- With version metadata

**POST /api/pages/[pageId]/versions**
- Valid version restoration (200)
- Without edit permission (403)
- Invalid version number (400)
- Missing version number (400)
- Non-existent version (404)
- Negative version number (400)
- Zero version number (400)
- Creates new version after restoration

**Coverage Target:** >75%

#### `audit-integration.test.ts` (20+ tests)

Tests for audit logging during CRUD operations:

**Page CRUD Operations:**
- Page creation logs audit event
- Page update logs audit event and creates version
- AI page edit logs AI action with operation ID
- Page deletion logs audit event with before state
- Page restoration logs audit event
- Bulk page operations use operation ID
- Permission changes log audit events
- Request context is captured
- Version snapshots capture full page state

**Activity Feed Queries:**
- Drive activity feed includes all events
- Activity feed filters AI vs human actions
- Activity stats aggregate metrics correctly

**Coverage Target:** >70%

## Running the Tests

### Prerequisites

1. **PostgreSQL Database**
   ```bash
   docker compose up postgres -d
   ```

2. **Environment Variables**
   ```bash
   # Create .env.test or ensure these are set
   JWT_SECRET=test-secret-key-minimum-32-characters-long
   JWT_ISSUER=pagespace-test
   JWT_AUDIENCE=pagespace-test-users
   DATABASE_URL=postgresql://test:test@localhost:5432/pagespace_test
   ```

### Run All Audit Tests

```bash
# Run all unit tests for audit functions
pnpm --filter @pagespace/lib test audit

# Run specific test file
pnpm --filter @pagespace/lib test audit-create-event
pnpm --filter @pagespace/lib test audit-page-version
pnpm --filter @pagespace/lib test audit-ai-operation
pnpm --filter @pagespace/lib test audit-query-events

# Run integration tests
pnpm --filter web test integration/audit

# Run all tests with coverage
pnpm test:coverage
```

### Run Tests in Watch Mode

```bash
pnpm --filter @pagespace/lib test:watch audit
```

### Generate Coverage Report

```bash
# Generate HTML coverage report
pnpm test:coverage

# View coverage for audit files specifically
pnpm test:coverage -- --coverage-include=packages/lib/src/audit/**
```

## Expected Coverage

| Module | Target | Description |
|--------|--------|-------------|
| `create-audit-event.ts` | >85% | Event creation and change tracking |
| `create-page-version.ts` | >85% | Version snapshots and restoration |
| `track-ai-operation.ts` | >85% | AI operation tracking |
| `query-audit-events.ts` | >80% | Event querying and filtering |
| **Overall Audit System** | **>80%** | **Combined coverage** |

## Test Patterns and Best Practices

### 1. Factory Functions

All tests use factory functions for data creation:

```typescript
// ✅ GOOD - Factory function invoked per test
test('with user', async () => {
  const user = await factories.createUser()
  // Test code
})

// ❌ BAD - Shared mutable fixture
const sharedUser = await factories.createUser()
test('with user', async () => {
  // Using shared state
})
```

### 2. Assert Pattern

Tests follow the 5 Questions Framework:

```typescript
test('with valid data', () => {
  const given = 'valid user data with email and name'
  const should = 'create audit event with all fields'

  const actual = await createAuditEvent({ ... })

  const expected = {
    actionType: 'PAGE_UPDATE',
    entityType: 'PAGE',
    // ...
  }

  expect(actual).toMatchObject(expected)
})
```

### 3. Test Isolation

Each test:
- Cleans up database state in `beforeEach`
- Uses fresh instances via factories
- Does not depend on other tests
- Can run in any order

### 4. Descriptive Test Names

```typescript
// ✅ GOOD - Describes scenario
test('with valid version restoration')
test('without edit permission')
test('with AI-generated version')

// ❌ BAD - Vague or implementation-focused
test('it works')
test('returns data')
```

## CI/CD Integration

### GitHub Actions Workflow

```yaml
- name: Run Audit Tests
  run: |
    pnpm --filter @pagespace/lib test audit
    pnpm --filter web test integration/audit

- name: Generate Coverage
  run: pnpm test:coverage

- name: Upload Coverage
  uses: codecov/codecov-action@v3
  with:
    files: ./coverage/lcov.info
```

## Troubleshooting

### Database Connection Issues

**Problem:** "Connection refused" or "ECONNREFUSED"

**Solution:**
```bash
docker compose up postgres -d
psql $DATABASE_URL -c "SELECT 1"
```

### Missing Environment Variables

**Problem:** "JWT_SECRET is required"

**Solution:** Ensure test setup files have proper env var configuration

### Test Timeouts

**Problem:** Tests timing out

**Solution:** Increase timeout in test configuration or check for hanging database connections

### Permission Test Failures

**Problem:** Expected access denied, got access granted

**Solution:** Verify permission logic, check drive owner status

## Future Enhancements

### Planned Test Additions

1. **Component Tests**
   - ActivityFeed component rendering
   - PageHistory component interaction
   - VersionCompare diff display
   - Loading states and error handling

2. **E2E Tests**
   - Complete user flow: create → edit → view history → restore
   - Admin flow: view activity feed → filter → export
   - AI flow: AI edits page → view changes → undo

3. **Performance Tests**
   - Large version history handling
   - High-volume activity feed queries
   - Bulk operation performance

4. **Security Tests**
   - Permission boundary testing
   - GDPR data export validation
   - Audit log tampering prevention

## Test Metrics

### Current Status

- **Total Test Suites:** 7
- **Total Tests:** 150+
- **Estimated Coverage:** >80%
- **Test Execution Time:** ~15 seconds (unit), ~30 seconds (integration)

### Coverage by Category

| Category | Tests | Coverage |
|----------|-------|----------|
| Unit Tests | 120+ | >85% |
| Integration Tests | 35+ | >75% |
| API Tests | 15+ | >75% |

## Maintenance

### When to Update Tests

1. **Schema Changes:** Update factories and test data
2. **New Action Types:** Add test cases for new audit actions
3. **New Query Functions:** Add corresponding test suites
4. **API Route Changes:** Update integration tests

### Test Review Checklist

- [ ] All tests follow 5 Questions Framework
- [ ] Tests are RITE (Readable, Isolated, Thorough, Explicit)
- [ ] Factory functions used instead of shared fixtures
- [ ] Descriptive test names
- [ ] Proper error handling tested
- [ ] Edge cases covered
- [ ] Coverage targets met

## References

- [TDD Best Practices Guide](../../3.0-guides-and-tools/tdd-best-practices.md)
- [Testing Strategy Overview](./testing-overview.md)
- [Audit System Architecture](../../2.0-architecture/audit-trail-and-versioning.md)
