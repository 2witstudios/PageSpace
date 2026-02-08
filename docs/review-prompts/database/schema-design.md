# Review Vector: Schema Design

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- database.mdc

## Scope
**Files**: `packages/db/src/schema/**`, `packages/db/src/schema.ts`
**Level**: service

## Context
The database schema is defined using Drizzle ORM in TypeScript and serves as the single source of truth for all PostgreSQL table definitions, column types, constraints, and defaults. Schema changes must be backward-compatible and generate clean migrations via drizzle-kit. Review should verify proper use of data types, NOT NULL constraints, default values, and that new tables follow established naming and structural conventions.
