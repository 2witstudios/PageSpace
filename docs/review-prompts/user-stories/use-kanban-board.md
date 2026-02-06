# Review Vector: Use Kanban Board

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/components/tasks/TasksDashboard.tsx`, `apps/web/src/components/tasks/TaskCompactRow.tsx`, `apps/web/src/components/tasks/TaskMobileCard.tsx`, `apps/web/src/components/tasks/TaskDetailSheet.tsx`, `apps/web/src/components/tasks/FilterControls.tsx`, `apps/web/src/components/tasks/types.ts`, `apps/web/src/app/api/pages/[pageId]/tasks/route.ts`, `apps/web/src/app/api/pages/[pageId]/tasks/[taskId]/route.ts`, `apps/web/src/app/api/pages/[pageId]/tasks/reorder/route.ts`, `apps/web/src/app/api/pages/[pageId]/tasks/statuses/route.ts`, `packages/db/src/schema/tasks.ts`
**Level**: domain

## Context
The kanban journey starts when a user views their task page in board mode, which renders task columns organized by custom statuses. Dragging a card between columns triggers the @dnd-kit drag-and-drop handler, which optimistically updates the UI, PATCHes the task status via the task API, and reorders via the reorder endpoint. The filter controls allow narrowing by assignee or status. This flow spans the frontend task components with drag-and-drop state management, optimistic SWR mutations, API route handlers enforcing page permissions, and database updates to task status and sort order fields.
