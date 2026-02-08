# Review Vector: View Activity Log

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/activities/route.ts`, `apps/web/src/app/api/activities/[activityId]/route.ts`, `apps/web/src/app/api/activities/actors/route.ts`, `apps/web/src/app/api/activities/export/route.ts`, `apps/web/src/components/activity/ActivityDashboard.tsx`, `apps/web/src/components/activity/ActivityTimeline.tsx`, `apps/web/src/components/activity/ActivityFilterBar.tsx`, `apps/web/src/components/activity/ActivityItem.tsx`, `apps/web/src/components/activity/ActorFilter.tsx`, `apps/web/src/components/activity/DateRangeFilter.tsx`, `apps/web/src/components/activity/ExportButton.tsx`, `apps/web/src/hooks/useActivitySocket.ts`, `packages/lib/src/monitoring/activity-tracker.ts`, `packages/lib/src/monitoring/activity-logger.ts`
**Level**: domain

## Context
The activity log journey starts when a user opens the activity dashboard, which fetches paginated activity entries from the activities API. The ActivityFilterBar allows filtering by actor, date range, and action type. New activities arrive in real-time via the activity socket hook, which listens for broadcasts from the realtime service. The export button triggers the export API to generate a downloadable activity report. This flow crosses the activity UI components with filtering and pagination, API route handlers, the activity tracking and logging services that produce entries, real-time socket updates, and the export data transformation pipeline.
