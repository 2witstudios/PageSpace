# Review Vector: Hook Test Patterns

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- tdd.mdc

## Scope
**Files**: `apps/web/src/hooks/__tests__/**`, `apps/web/src/hooks/**/*.test.ts`
**Level**: testing

## Context
Custom React hooks must be tested using renderHook from testing-library to properly exercise the React lifecycle. Tests should validate initial state, state transitions after actions, cleanup on unmount, and dependency-driven re-execution. Hooks that depend on SWR, Zustand stores, or Socket.IO connections require careful mocking to isolate the hook logic from external dependencies.
