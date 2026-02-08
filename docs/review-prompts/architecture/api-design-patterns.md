# Review Vector: API Design Patterns

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/**/route.ts`
**Level**: architectural

## Context
The API layer consists of Next.js 15 route handlers that serve as the interface between the frontend and the database/service layer. Review whether routes follow consistent patterns for authentication, request validation, response shaping, pagination, and error responses, and whether the API surface area is organized in a way that maps cleanly to domain concepts.
