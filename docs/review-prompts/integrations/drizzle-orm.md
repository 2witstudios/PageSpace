# Review Vector: Drizzle ORM Integration

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- tdd.mdc
- stack.mdc

## Scope
**Files**: `packages/db/src/**`, `packages/lib/src/repositories/**`
**Level**: integration

## Context
Drizzle ORM serves as the centralized database access layer with schema definitions, migration generation, and typed query building across the monorepo. Schema changes must flow through the `pnpm db:generate` migration workflow and never involve manual SQL file edits. Repository patterns in the shared lib package should use Drizzle's query builder consistently, leveraging relation definitions for joins and avoiding raw SQL unless performance profiling demands it.
