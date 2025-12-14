# PageSpace Testing Suite

Comprehensive testing infrastructure for PageSpace with 2500+ tests covering unit, integration, API routes, hooks, stores, and real-time scenarios.

## Quick Start

```bash
# Run all tests (via Turbo - runs in parallel)
pnpm test

# Run specific test suites
pnpm test:unit                # Unit tests (@pagespace/lib + apps/web)
pnpm test:watch               # Watch mode for @pagespace/lib
pnpm test:coverage            # Coverage report for @pagespace/lib

# Run tests for specific package
pnpm --filter @pagespace/lib test      # 530 tests
pnpm --filter web test                 # 1984 tests
pnpm --filter realtime test            # 34 tests
pnpm --filter @pagespace/processor test # 6 tests
```

## Test Distribution

| Package | Test Files | Tests | Description |
|---------|-----------|-------|-------------|
| `@pagespace/lib` | 20 | 530 | Auth, permissions, encryption, rate limiting, utilities |
| `apps/web` | 120 | 1984 | API routes, hooks, stores, components, AI tools |
| `apps/realtime` | 2 | 34 | Socket.IO authentication and room management |
| `apps/processor` | 1 | 6 | File processing security utilities |
| **Total** | **143** | **2554** | |

## Running Package Tests

### apps/web

Tests are colocated with source files in `__tests__` subdirectories.

```bash
cd apps/web

# Run all web tests
pnpm test

# Run specific test file
pnpm vitest run src/lib/websocket/__tests__/ws-connections.test.ts

# Run with verbose output
pnpm vitest run --reporter=verbose

# Watch mode
pnpm vitest --watch
```

### packages/lib

```bash
cd packages/lib

# Run all lib tests
pnpm test

# Run specific test
pnpm vitest run src/__tests__/auth-utils.test.ts

# With coverage
pnpm vitest run --coverage
```

### apps/realtime

```bash
cd apps/realtime
pnpm test
```

### apps/processor

```bash
cd apps/processor
pnpm test
```

## Test Categories

### Unit Tests (packages/lib) - 530 tests

- **Permissions** (`src/__tests__/permissions.test.ts`): Access control, drive ownership, page permissions
- **Authentication** (`src/__tests__/auth-utils.test.ts`): JWT generation, validation, token refresh
- **Rate Limiting** (`src/__tests__/rate-limit-utils.test.ts`): Request throttling, window management
- **Encryption** (`src/__tests__/encryption.test.ts`): Data encryption/decryption
- **Sheet Engine** (`src/__tests__/sheet-advanced.test.ts`): Spreadsheet formulas, calculations
- **Caching** (`src/__tests__/permission-cache.test.ts`): Permission caching layer
- **Utilities** (`src/__tests__/`): Various utility functions

### API Route Tests (apps/web) - 800+ tests

- **Auth Routes** (`src/app/api/auth/__tests__/`): Login, signup, logout, token refresh
- **Pages Routes** (`src/app/api/pages/__tests__/`): CRUD operations, tree management
- **Drives Routes** (`src/app/api/drives/__tests__/`): Drive management, membership
- **AI Routes** (`src/app/api/ai/__tests__/`): Chat, completions, tool execution
- **Stripe Routes** (`src/app/api/stripe/__tests__/`): Subscriptions, billing, webhooks
- **Account Routes** (`src/app/api/account/__tests__/`): Profile, settings

### Hooks & Stores Tests (apps/web) - 400+ tests

- **Hooks** (`src/hooks/__tests__/`): Custom React hooks
- **Stores** (`src/stores/__tests__/`): Zustand stores
- **WebSocket** (`src/lib/websocket/__tests__/`): Connection management, message schemas

### Component Tests (apps/web) - 200+ tests

- **AI Components** (`src/components/ai/__tests__/`): Chat interface, model selectors
- **UI Components** (`src/components/__tests__/`): Various UI components

### Real-time Tests (apps/realtime) - 34 tests

- **Authentication** (`src/__tests__/auth.test.ts`): Socket.IO token validation
- **Room Management** (`src/__tests__/rooms.test.ts`): Room joining, leaving, broadcasting

### Security Tests (apps/processor) - 6 tests

- **Security Utils** (`tests/security-utils.test.ts`): Path sanitization, traversal prevention

## Architecture

### Vitest Workspace Configuration

The monorepo uses a vitest workspace (`vitest.workspace.ts`) that defines test projects:

```typescript
export default defineWorkspace([
  { test: { name: '@pagespace/lib', root: './packages/lib', environment: 'node' } },
  { test: { name: 'web', root: './apps/web', environment: 'jsdom' } },
  { test: { name: 'realtime', root: './apps/realtime', environment: 'node' } },
  { test: { name: 'processor', root: './apps/processor', environment: 'node' } },
])
```

### Test Data Management

**Factories** (`packages/db/src/test/factories.ts`):
```typescript
import { factories } from '@pagespace/db/test/factories'

const user = await factories.createUser({ email: 'test@example.com' })
const drive = await factories.createDrive(user.id)
const page = await factories.createPage(drive.id, { type: 'AI_CHAT' })
```

**Auth Helpers** (`packages/lib/src/test/auth-helpers.ts`):
```typescript
import { authHelpers } from '@pagespace/lib/test/auth-helpers'

const token = await authHelpers.createTestToken(userId, 'admin')
const expiredToken = await authHelpers.createExpiredToken(userId)
```

**Socket Mocks** (`apps/web/src/test/socket-mocks.ts`):
```typescript
import { createMockSocket, createMockElectron } from '@/test/socket-mocks'

const mockSocket = createMockSocket()
const mockElectron = createMockElectron()
```

### Critical Testing Patterns

**Next.js 15 Async Params**:
```typescript
// CORRECT - params must be awaited
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  // ...
}
```

**Permission Testing**:
```typescript
const access = await getUserAccessLevel(userId, pageId)
expect(access?.canEdit).toBe(true)
```

**Database Cleanup** (for integration tests):
```typescript
afterEach(async () => {
  await db.execute(sql`TRUNCATE TABLE pages, drives, users CASCADE`)
})
```

## Coverage Targets

- Unit tests: >80%
- Integration tests: >70%
- Overall project: >75%

## CI/CD Integration

Tests run automatically via GitHub Actions (`.github/workflows/test.yml`):

- **Trigger**: Push to main/master/develop, Pull requests
- **Services**: PostgreSQL 16, Redis 7
- **Command**: `pnpm test` (runs all tests via Turbo)

```yaml
- name: Run tests
  env:
    DATABASE_URL: postgresql://postgres:postgres@localhost:5432/pagespace_test
    REDIS_URL: redis://localhost:6379
    JWT_SECRET: test-secret-key-minimum-32-characters-long-for-ci
  run: pnpm test
```

## Environment Setup

### Required Environment Variables

```bash
JWT_SECRET=test-secret-key-minimum-32-characters-long
JWT_ISSUER=pagespace-test
JWT_AUDIENCE=pagespace-test-users
DATABASE_URL=postgresql://test:test@localhost:5432/pagespace_test
```

Test setup files (`packages/lib/src/test/setup.ts`, `apps/web/src/test/setup.ts`) automatically configure these for local development.

### Database Setup

```bash
# Start PostgreSQL with Docker
docker compose up postgres -d

# Run migrations
pnpm --filter @pagespace/db db:migrate
```

## Test File Locations

```
PageSpace/
├── packages/
│   ├── lib/
│   │   └── src/
│   │       ├── __tests__/           # Unit tests (530 tests)
│   │       └── test/                # Test setup & helpers
│   └── db/
│       └── src/
│           └── test/                # Database factories
├── apps/
│   ├── web/
│   │   └── src/
│   │       ├── test/                # Setup & mocks
│   │       ├── app/api/**/__tests__/ # API route tests
│   │       ├── hooks/**/__tests__/   # Hook tests
│   │       ├── stores/__tests__/     # Store tests
│   │       ├── components/**/__tests__/ # Component tests
│   │       └── lib/**/__tests__/     # Library tests
│   ├── realtime/
│   │   └── src/
│   │       └── __tests__/           # Socket.IO tests (34 tests)
│   └── processor/
│       └── tests/                   # Security tests (6 tests)
└── .github/
    └── workflows/
        └── test.yml                 # CI/CD pipeline
```

## Troubleshooting

### Tests timing out
```typescript
test('slow operation', { timeout: 10000 }, async () => {
  // test code
})
```

### Database connection errors
```bash
# Ensure PostgreSQL is running
docker compose up postgres -d

# Check connection
psql $DATABASE_URL
```

### Socket.IO tests failing
```bash
# Verify realtime service is not already running
lsof -ti:3001 | xargs kill
```

### Permission tests failing without database
Some `@pagespace/lib` tests require PostgreSQL for integration testing. These pass in CI but may fail locally without a database. Unit tests that don't require a database will still pass.

## Best Practices

1. **Test Isolation**: Each test should be independent
2. **Descriptive Names**: Use clear, specific test names
3. **Arrange-Act-Assert**: Follow AAA pattern
4. **Mock External Services**: AI providers, email, payment processors
5. **Test Permissions**: Always verify access control
6. **Clean Up**: Use afterEach hooks to reset state
7. **Async Params**: Follow Next.js 15 pattern for route handlers
8. **Colocate Tests**: Keep tests near the code they test (`__tests__/` directories)

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [Testing Library](https://testing-library.com/)
- [Next.js Testing](https://nextjs.org/docs/app/building-your-application/testing)
