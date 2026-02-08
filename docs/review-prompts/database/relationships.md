# Review Vector: Relationships

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- database.mdc

## Scope
**Files**: `packages/db/src/schema/**`
**Level**: service

## Context
Database relationships are defined through foreign keys, junction tables, and Drizzle's relations API to model connections between users, drives, pages, files, and other entities. Referential integrity must be enforced at the database level with appropriate cascade and restrict behaviors. Review should verify that relationship definitions match the application's domain model, that orphaned records cannot be created, and that junction tables have proper composite keys.
