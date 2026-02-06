# Review Vector: Error Handling

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `apps/web/src/app/**/error.tsx`, `apps/web/src/app/api/**/route.ts`
**Level**: architectural

## Context
Error handling spans React error boundaries on the frontend and structured error responses from API routes on the backend. Review whether error boundaries exist at appropriate levels of the component tree, whether API routes return consistent error shapes and status codes, and whether errors are caught, logged, and surfaced to users in a coherent way across the full stack.
