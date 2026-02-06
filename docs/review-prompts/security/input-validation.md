# Review Vector: Input Validation

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc

## Scope
**Files**: `packages/lib/src/validators/**`, `apps/web/src/app/api/**/route.ts`
**Level**: service

## Context
The validators package provides shared validation logic consumed by API route handlers that parse request bodies and URL parameters. Review whether validation is applied consistently at the boundary of every route handler before business logic executes. Examine the validator implementations for completeness: type coercion edge cases, missing field handling, maximum length enforcement, and whether nested object structures are validated recursively rather than shallowly.
