# Review Vector: Rollback Changes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/pages/[pageId]/history/route.ts`, `apps/web/src/app/api/pages/[pageId]/versions/compare/route.ts`, `apps/web/src/app/api/activities/[activityId]/rollback/route.ts`, `apps/web/src/app/api/activities/[activityId]/rollback-to-point/route.ts`, `apps/web/src/components/activity/ActivityTimeline.tsx`, `apps/web/src/components/activity/RollbackToPointDialog.tsx`, `packages/lib/src/permissions/rollback-permissions.ts`, `packages/db/src/schema/versioning.ts`, `packages/lib/src/content/activity-diff-utils.ts`
**Level**: domain

## Context
The rollback journey begins when a user opens the activity timeline for a page and browses version history entries. The compare endpoint generates diffs between versions using the activity-diff-utils. Selecting a rollback target opens the RollbackToPointDialog, which calls the rollback-to-point API after verifying rollback permissions. The API restores the page content to the selected version, creates a new activity log entry for the rollback action, and updates the page. This flow crosses the history and versioning APIs, permission enforcement via rollback-specific permission logic, diff generation, database versioning schema, and activity timeline UI components.
