# Review Vector: Activity Feed

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc
- permissions.mdc

## Scope
**Files**: `apps/web/src/components/activity/**`, `apps/web/src/app/api/activities/**`, `apps/web/src/app/api/activity/**`
**Level**: domain

## Context
The activity feed tracks page edits, task changes, membership updates, and other system events with filtering and cursor-based pagination. API routes must enforce drive-level and page-level permissions so users only see activity they are authorized to view. The frontend renders heterogeneous activity types with distinct layouts and supports infinite scroll loading for large activity histories.
