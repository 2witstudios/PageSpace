# Review Vector: Store Test Patterns

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- tdd.mdc

## Scope
**Files**: `apps/web/src/stores/__tests__/**`, `apps/web/src/stores/**/*.test.ts`
**Level**: testing

## Context
Zustand store tests should validate state transitions, action side effects, and selector behavior in isolation. Each test must reset store state in setup to prevent cross-test contamination. Stores with middleware like persist or devtools require specific mocking strategies to test the underlying logic without triggering storage or logging side effects.
