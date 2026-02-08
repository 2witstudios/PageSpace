# Review Vector: Rollback System

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc
- permissions.mdc

## Scope
**Files**: `apps/web/src/app/api/activities/[activityId]/rollback-to-point/**`
**Level**: domain

## Context
The rollback system restores a page to a specific version or activity point, requiring write permissions and careful state reconstruction. The API must validate the activity ID, confirm the user has edit access, and atomically apply the historical state while creating a new activity entry for the rollback itself. Error handling must prevent partial rollbacks that could leave content in an inconsistent state.
