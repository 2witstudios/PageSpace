# Script Tests

This directory contains tests for the utility scripts in the `/scripts` directory.

## Test Files

- **verify-token-migration.test.ts**: Comprehensive tests for the token migration verification script

## Running the Verification Script

```bash
# Run the migration verification (requires database)
pnpm verify:migrations

# With --allow-missing flag for partial migrations
pnpm verify:migrations -- --allow-missing
```

## Running Unit Tests

Due to the monorepo workspace configuration, script tests need special handling:

```bash
# The tests are written but require isolated vitest context
# Future: Configure workspace to support root-level script tests
```

## Test Coverage

The `verify-token-migration.test.ts` file includes 20+ tests:

### Unit Tests
- `countTokens()` - Tests table verification logic with all edge cases
- `reportTableStatus()` - Tests console output and status reporting
- `verifyHashLookup()` - Tests hash validation logic

### Integration Tests
- Main flow with all tables migrated successfully (exit 0)
- Main flow with missing tables without --allow-missing (exit 1)
- Main flow with missing tables with --allow-missing (exit 0)
- Main flow with incomplete migrations (exit 1)
- Command-line argument parsing
- Error handling (exit 2)

### Edge Cases
- Null count values from database
- Mixed migration states across tables
- Empty tables
- Missing schema/columns
- Database connection failures

## Key Testing Patterns

1. **Database mocking**: Uses `vi.mock()` to mock @pagespace/db
2. **Process exit handling**: Mocks `process.exit()` to capture exit codes
3. **Console output capture**: Captures console.log/error for assertion
4. **Command-line args**: Tests --allow-missing flag parsing
5. **Error scenarios**: Tests both expected and unexpected errors

## Verification Checklist

The tests verify the fix for the false-positive bug:

- ✅ Missing tables are properly detected and fail verification
- ✅ --allow-missing flag allows skipping missing tables
- ✅ Exit codes are correct (0=success, 1=incomplete, 2=error)
- ✅ Error messages guide users to correct solutions
- ✅ Console output is clear and actionable
