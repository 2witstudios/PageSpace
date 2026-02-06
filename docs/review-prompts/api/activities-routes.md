# Review Vector: Activities Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/activities/**/route.ts`, `apps/web/src/app/api/activity/**/route.ts`
**Level**: route

## Context
Activity routes provide the audit trail for page and drive changes: listing activities with filtering by actor, exporting activity logs, viewing individual activity details, and performing rollback operations (both single-activity undo and rollback-to-point). The activity summary endpoint provides aggregated change statistics. Rollback operations are destructive and must verify that the user has edit permissions on the affected page and that the target state is valid. Activity listing must respect drive membership boundaries so users cannot observe changes in drives they do not belong to.
