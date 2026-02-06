# Review Vector: Test Isolation

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- tdd.mdc

## Scope
**Files**: `apps/web/src/**/*.test.ts`, `apps/web/vitest.config.*`
**Level**: testing

## Context
Each test must be independently executable without relying on execution order or shared mutable state from other tests. Setup and teardown hooks should fully reset all mocks, store state, and module-level singletons between test cases. The Vitest configuration should enforce isolation boundaries and any global test setup should be explicitly declared and minimal in scope.
