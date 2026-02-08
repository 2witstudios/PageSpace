# Review Vector: Indexes & Performance

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- database.mdc

## Scope
**Files**: `packages/db/src/schema/**`, `packages/db/drizzle/**`
**Level**: service

## Context
Index definitions in the schema directly impact query performance for lookups, joins, sorting, and filtering across all application surfaces. Missing indexes cause slow queries under load while redundant indexes waste storage and slow writes. Review should verify that indexes cover high-frequency query patterns, that composite indexes have correct column ordering, and that new migrations adding indexes include CONCURRENTLY where appropriate to avoid table locks.
