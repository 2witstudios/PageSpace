# Review Vector: Mock Patterns

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- tdd.mdc

## Scope
**Files**: `apps/web/src/**/*.test.ts`, `apps/web/src/__mocks__/**`, `packages/lib/src/test/**`, `packages/db/src/test/**`
**Level**: testing

## Context
Mock implementations must be consistent across the test suite, using shared mock factories from centralized test utilities rather than ad-hoc inline mocks. All mocks should be properly restored or cleared in afterEach hooks to prevent leakage between tests. Database mocks, authentication mocks, and external service mocks each follow established patterns that new tests should reuse rather than reinvent.
