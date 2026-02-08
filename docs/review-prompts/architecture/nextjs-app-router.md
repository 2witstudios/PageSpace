# Review Vector: Next.js App Router

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/**/*.{ts,tsx}`, `apps/web/src/middleware.ts`
**Level**: architectural

## Context
The web app uses Next.js 15 App Router with the critical breaking change that dynamic route params are now Promises and must be awaited. This affects every route handler, layout, and page component that receives params. Review the routing hierarchy, middleware logic, layout nesting strategy, and whether all async params patterns are correctly implemented throughout the codebase.
