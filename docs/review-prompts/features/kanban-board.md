# Review Vector: Kanban Board

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- dnd-kit.mdc

## Scope
**Files**: `apps/web/src/components/tasks/**`
**Level**: domain

## Context
The Kanban view uses @dnd-kit for drag-and-drop between status columns, requiring correct sensor configuration and collision detection strategies. Column ordering and task positioning must persist correctly through API calls when items are moved between or within columns. Optimistic UI updates should maintain visual consistency even when the server response is delayed or fails.
