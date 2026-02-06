# Review Vector: SQL Injection Prevention

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc

## Scope
**Files**: `packages/db/src/**`, `apps/web/src/app/api/**/route.ts`
**Level**: service

## Context
Database access is mediated through Drizzle ORM which parameterizes queries by default, but raw SQL escape hatches, dynamic column selection, and string interpolation in query construction can reintroduce injection vulnerabilities. Review the codebase for any use of raw SQL functions, sql.raw(), or template literal construction that bypasses Drizzle's parameterization. Examine dynamic query building patterns where user input influences column names, table names, or ORDER BY clauses, as these are commonly overlooked injection surfaces even in ORM-heavy codebases.
