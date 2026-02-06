# Review Vector: Unit Test Coverage

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- tdd.mdc

## Scope
**Files**: `apps/web/src/**/__tests__/**`, `apps/web/src/**/*.test.ts`, `packages/**/__tests__/**`, `packages/**/*.test.ts`
**Level**: testing

## Context
Overall unit test coverage across the monorepo should meet or exceed the 75% target. Tests should validate pure functions, utilities, and isolated business logic using proper assert structures with given/should/actual/expected patterns. Coverage gaps in critical paths like permissions, content processing, and state management represent the highest risk areas to address.
