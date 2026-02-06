# Review Vector: Data Flow

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `packages/db/src/**`, `apps/web/src/app/api/**`, `apps/web/src/stores/**`, `apps/web/src/hooks/**`
**Level**: architectural

## Context
Data flows from PostgreSQL through Drizzle ORM in the db package, up through Next.js API routes, into SWR caches and Zustand stores, and finally into React components via custom hooks. Review the end-to-end data path for consistency, whether transformations between layers are clean and typed, and whether there are any places where data shape assumptions break across boundaries.
