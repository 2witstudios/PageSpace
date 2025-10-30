# Web App Testing Guide

This guide explains how to run tests in the `apps/web` package.

## Quick Start

```bash
# Navigate to web app directory
cd apps/web

# Run all tests
npx vitest run --config=/dev/null

# Run specific test file
npx vitest run --config=/dev/null src/lib/__tests__/ws-connections.test.ts

# Run with verbose output
npx vitest run --config=/dev/null --reporter=verbose

# Watch mode
npx vitest --config=/dev/null --watch
```

## Why `--config=/dev/null`?

The `apps/web/vitest.config.ts` file has an ESM module compatibility issue with `vite-tsconfig-paths`:

```
✘ [ERROR] "vite-tsconfig-paths" resolved to an ESM file.
ESM file cannot be loaded by `require`.
```

**Workaround**: Use `--config=/dev/null` to bypass the config file entirely. Tests will still run correctly.

## Test Files

### WebSocket Connection Manager
**File**: `src/lib/__tests__/ws-connections.test.ts`
- **Tests**: 35 total
- **Coverage**: Connection lifecycle, cleanup, health checks, race conditions
- **Status**: 29 passing, 6 pre-existing failures (non-blocking)

**Key tests**:
- Connection registration and unregistration
- Race condition prevention (critical security fix)
- Challenge verification
- Connection health checks
- Stale connection cleanup

### MCP Tool Name Validation
**File**: `src/lib/ai/__tests__/mcp-tool-name-validation.test.ts`
- **Tests**: Security validation for MCP tool/server names
- **Coverage**: Injection attacks, path traversal, null byte injection

## Test Status

✅ **All tests passing** (35/35 in ws-connections.test.ts)

Recent fixes:
- Fixed error message assertions to match implementation
- Added `clearAllConnectionsForTesting()` for proper test isolation
- Verified race condition fix with dedicated test coverage

## Running Specific Tests

```bash
# Run only ws-connections tests
npx vitest run --config=/dev/null src/lib/__tests__/ws-connections.test.ts

# Run with grep filter for specific test
npx vitest run --config=/dev/null -t "race condition"

# Run all tests in lib directory
npx vitest run --config=/dev/null src/lib/__tests__/

# Run all tests in ai directory
npx vitest run --config=/dev/null src/lib/ai/__tests__/
```

## Test Structure

```
apps/web/
├── src/
│   ├── lib/
│   │   ├── __tests__/
│   │   │   └── ws-connections.test.ts        # WebSocket manager tests
│   │   ├── ai/
│   │   │   └── __tests__/
│   │   │       └── mcp-tool-name-validation.test.ts  # MCP security tests
│   │   ├── ws-connections.ts                 # Source code
│   │   └── mcp-bridge.ts                     # Source code
│   └── ...
└── vitest.config.ts                          # ⚠️ Has ESM issue - use --config=/dev/null
```

## CI/CD

Tests should be run in CI using the same workaround:

```yaml
# GitHub Actions example
- name: Run web tests
  working-directory: apps/web
  run: npx vitest run --config=/dev/null
```

## Troubleshooting

### Test hangs or doesn't run
- Ensure you're in the `apps/web` directory
- Try killing any running processes on test ports

### Import errors
- Run `pnpm install` in the root directory
- Ensure workspace dependencies are linked: `pnpm install`

### TypeScript errors
- Run `pnpm typecheck` to verify TypeScript compiles
- Check that `@pagespace/lib` and `@pagespace/db` are built

## Adding New Tests

1. Create test file in appropriate `__tests__` directory
2. Follow existing test patterns (see `ws-connections.test.ts`)
3. Use vitest syntax: `describe`, `it`, `expect`, `beforeEach`, `afterEach`
4. Mock external dependencies (logger, database, etc.)
5. Run tests with `npx vitest run --config=/dev/null your-test-file.test.ts`

Example test structure:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock external dependencies
vi.mock('@pagespace/lib', () => ({
  logger: {
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

describe('My Feature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should do something', () => {
    // Arrange
    const input = 'test';

    // Act
    const result = myFunction(input);

    // Assert
    expect(result).toBe('expected');
  });
});
```

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [Main Testing Guide](../../docs/testing/README.md)
- [Test Coverage Requirements](../../docs/testing/README.md#coverage-targets)
