# Why Drizzle ORM

> Type-safe database access with PostgreSQL

## The Decision

Drizzle ORM was chosen over Prisma, Knex, or raw SQL for database access. This decision shaped the entire data layer architecture.

## Key Architectural Choices

### Drizzle Over Prisma

**The Choice**: Drizzle ORM instead of the more popular Prisma.

**Why**:
- SQL-like syntax feels natural
- No binary engine required (Prisma's query engine)
- Better TypeScript inference
- Migrations as plain SQL files
- Lighter runtime footprint

**Trade-offs**:
- Smaller ecosystem than Prisma
- Less automatic relation handling
- Required more explicit query construction

### Centralized in `@pagespace/db`

**The Choice**: Database logic lives in a dedicated package.

**Why**:
- Single source of truth for schema
- Shared across apps (web, realtime, processor)
- Consistent migration management
- Type exports for the entire monorepo

### Migration Strategy

**The Choice**: Generated migrations, never hand-written.

**Why**:
- Schema changes in TypeScript, migrations auto-generated
- Reduces human error in SQL
- `pnpm db:generate` creates migrations from schema diffs

**Critical Rule**:
> NEVER manually create or edit SQL migration files in `packages/db/drizzle/`

## Schema Evolution

*This section will track major schema changes as commits are processed:*
- Initial schema design
- Relation additions
- Index optimizations
- Breaking changes and migrations

## Key Schema Patterns

*To be documented as analysis proceeds.*

---

*Last updated: 2026-01-21 | Version: 0*
