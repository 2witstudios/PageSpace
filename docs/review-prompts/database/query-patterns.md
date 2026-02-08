# Review Vector: Query Patterns

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- database.mdc

## Scope
**Files**: `packages/db/src/**`, `packages/lib/src/repositories/**`
**Level**: service

## Context
Query patterns span the db package utilities and repository layer, using Drizzle ORM's query builder for type-safe database access. Queries must use parameterized inputs, avoid N+1 patterns, and leverage joins and subqueries efficiently. Review should check for proper use of select projections to avoid over-fetching, correct transaction boundaries for multi-table operations, and that complex queries remain readable and maintainable.
