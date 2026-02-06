# Review Vector: Tasks Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/tasks/**/route.ts`, `apps/web/src/app/api/pages/[pageId]/tasks/**/route.ts`
**Level**: route

## Context
Task routes provide both a cross-drive task aggregation endpoint and page-scoped task management: creating tasks, updating individual tasks, reordering within a page, and managing custom task statuses. Tasks support multiple assignees, custom status workflows, and are tied to page permissions. The top-level tasks endpoint aggregates tasks across all drives the user belongs to, requiring efficient multi-drive permission filtering. Reorder operations must handle concurrent modifications without losing position data.
