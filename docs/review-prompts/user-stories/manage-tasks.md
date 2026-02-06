# Review Vector: Manage Tasks

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/pages/[pageId]/tasks/route.ts`, `apps/web/src/app/api/pages/[pageId]/tasks/[taskId]/route.ts`, `apps/web/src/app/api/pages/[pageId]/tasks/statuses/route.ts`, `apps/web/src/app/api/pages/[pageId]/tasks/reorder/route.ts`, `apps/web/src/app/api/tasks/route.ts`, `apps/web/src/components/tasks/TasksDashboard.tsx`, `apps/web/src/components/tasks/TaskDetailSheet.tsx`, `apps/web/src/components/tasks/TaskCompactRow.tsx`, `apps/web/src/components/tasks/FilterControls.tsx`, `packages/db/src/schema/tasks.ts`, `packages/lib/src/permissions/permissions.ts`
**Level**: domain

## Context
Task management begins with creating a task on a page via the tasks API, which validates page-level permissions and inserts the task record with custom status support. The user can set statuses, assign multiple members, and reorder tasks via drag-and-drop in the TasksDashboard component. Status changes trigger activity log entries and may notify assignees. This journey crosses the task API routes with Next.js 15 async params, permission enforcement, database operations on the tasks schema, frontend components with @dnd-kit drag-and-drop, and cross-drive task aggregation via the global tasks route.
