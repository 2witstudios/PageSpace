# Review Vector: User Favorites Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/user/**/route.ts`
**Level**: route

## Context
User routes manage sidebar favorites (add, remove, reorder) and recently accessed pages. Favorites provide quick navigation to frequently used pages and drives, with user-controlled ordering. The recents endpoint tracks page visit history for the "recently viewed" section. These endpoints must verify that favorited or recently viewed items still exist and that the user retains access to them, filtering out pages from drives the user has been removed from. Reorder operations must handle optimistic UI updates and concurrent modifications gracefully.
