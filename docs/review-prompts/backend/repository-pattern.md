# Review Vector: Repository Pattern

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- database.mdc

## Scope
**Files**: `packages/lib/src/repositories/**`, `apps/web/src/lib/repositories/**`
**Level**: service

## Context
Repositories provide the data access abstraction layer between services and the Drizzle ORM, encapsulating query construction and result mapping. They must maintain a clean separation from business logic and never leak database-specific concerns to callers. Review should verify consistent return types, proper use of transactions when needed, and that no raw SQL bypasses the repository boundary.
