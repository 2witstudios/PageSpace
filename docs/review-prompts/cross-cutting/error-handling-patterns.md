# Review Vector: Error Handling Patterns

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `apps/web/src/app/api/**/route.ts`, `packages/lib/src/**`
**Level**: cross-cutting

## Context
API route handlers and shared library functions must follow consistent error handling patterns that convert exceptions into structured responses. Review that all route handlers use try/catch with appropriate HTTP status codes, that error messages do not leak internal details to clients, and that shared utility functions return result objects rather than throwing when feasible.
