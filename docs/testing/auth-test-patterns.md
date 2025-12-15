# Auth Route Test Patterns & Architecture Recommendations

## Overview

This document captures the testing patterns and architectural recommendations for the auth route test suite. It addresses common anti-patterns found in route tests and provides guidance for maintaining high-quality, refactor-resilient tests.

## High-Severity Issue: Query-Builder Chain Mocking

### The Problem

Many auth route tests currently use deep query-builder chain mocks like:

```typescript
vi.mock('@pagespace/db', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'user-id' }]),
      }),
    }),
  },
}));
```

This creates several problems:

1. **Refactor Tax**: Changing ORM query structure breaks tests even when behavior is unchanged
2. **False Confidence**: Tests pass because mocks match implementation, not because behavior is correct
3. **Implementation Coupling**: Tests are tightly coupled to Drizzle ORM internals
4. **Maintenance Burden**: Any ORM update requires updating many test files

### Recommended Solution: Repository/Service Seams

Instead of mocking the ORM directly in route tests, introduce a repository layer:

```typescript
// packages/lib/src/repositories/user-repository.ts
export interface UserRepository {
  findByEmail(email: string): Promise<User | null>;
  create(data: CreateUserData): Promise<User>;
  updateTokenVersion(userId: string): Promise<void>;
}

export const userRepository: UserRepository = {
  async findByEmail(email) {
    return db.query.users.findFirst({
      where: eq(users.email, email),
    });
  },
  async create(data) {
    const [user] = await db.insert(users).values(data).returning();
    return user;
  },
  // ...
};
```

Then in route tests, mock the repository:

```typescript
vi.mock('@pagespace/lib/repositories/user-repository', () => ({
  userRepository: {
    findByEmail: vi.fn(),
    create: vi.fn(),
  },
}));

// Tests can now mock at the boundary:
(userRepository.findByEmail as Mock).mockResolvedValue(mockUser);
(userRepository.create as Mock).mockResolvedValue(createdUser);
```

### Implementation Priority

Files requiring repository seams (in priority order):

| File | Chain Mocks | Priority |
|------|-------------|----------|
| signup.test.ts | insert().values().returning() | High |
| login.test.ts | query.users.findFirst, insert() | High |
| refresh.test.ts | transaction(), delete(), update() | Medium |
| logout.test.ts | delete().where() | Medium |
| device-refresh.test.ts | update().set().where() | Low |

## Test Pattern Guidelines

### 1. Cookie Contract Assertions (Not Counts)

**Bad:**
```typescript
expect(serialize).toHaveBeenCalledTimes(2);
```

**Good:**
```typescript
// Assert cookie contract: names, security attributes, values
expect(serialize).toHaveBeenCalledWith(
  'accessToken',
  expect.any(String),
  expect.objectContaining({
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
  })
);
```

### 2. Security Property Tests (Not Implementation Details)

**Bad:**
```typescript
// Pinned to specific dummy hash value
const DUMMY_HASH = '$2a$12$LQv3c1yqBWVH...';
expect(bcrypt.compare).toHaveBeenCalledWith(password, DUMMY_HASH);
```

**Good:**
```typescript
// Test the security property: timing-safe comparison occurs
expect(bcrypt.compare).toHaveBeenCalled();
const [password, hash] = (bcrypt.compare as Mock).mock.calls[0];
expect(password).toBe('anypassword');
expect(hash).toBeTruthy();
expect(hash).toMatch(/^\$2[aby]?\$\d+\$/); // Valid bcrypt hash format
```

### 3. Capture-and-Assert for Boundary Calls

**Bad:**
```typescript
expect(db.insert).toHaveBeenCalled(); // Bare assertion
```

**Good:**
```typescript
// Capture and verify actual values
let capturedUserData: Record<string, unknown> | undefined;
const mockValues = vi.fn().mockImplementation((data) => {
  capturedUserData = data;
  return { returning: vi.fn().mockResolvedValue([...]) };
});
(db.insert as Mock).mockReturnValue({ values: mockValues });

// After calling the route:
expect(capturedUserData!.email).toBe('user@example.com');
expect(capturedUserData!.password).toMatch(/^\$2[aby]?\$\d+\$/);
```

## Integration Backstop Recommendation

While unit tests with good assertions provide strong coverage, auth flows are easy to mock into false agreement. Consider adding a minimal integration test suite for critical flows:

1. **Login flow**: Real bcrypt, real JWT generation, real cookie setting
2. **Signup flow**: Real user creation, real token generation
3. **Refresh flow**: Real token rotation, real session invalidation
4. **Logout flow**: Real cookie clearing, real token deletion

These can run against an in-memory SQLite database or test PostgreSQL instance.

## Summary of Changes Made

The following improvements were implemented in this review:

1. **login.test.ts**:
   - Removed cookie count assertion (line 138)
   - Replaced DUMMY_HASH check with security property test

2. **logout.test.ts**:
   - Removed cookie count assertion (line 115)
   - Cookie contract assertions already present

3. **mobile-login.test.ts**:
   - Enhanced timing-safe test with proper property assertions

4. **signup.test.ts**:
   - Added capture-and-assert for user creation data
   - Verifies email, name, and hashed password

Run `pnpm test:unit` or check CI to verify all auth tests pass.
