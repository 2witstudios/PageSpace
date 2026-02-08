# Review Vector: Validation Patterns

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `packages/lib/src/validators/**`, `apps/web/src/app/api/**/route.ts`
**Level**: cross-cutting

## Context
Input validation is applied at API route boundaries and through shared validator utilities in the lib package. Review that all user-facing endpoints validate request bodies, query parameters, and path params before processing, that validators are reused rather than duplicated across routes, and that validation errors return clear, actionable messages to callers.
