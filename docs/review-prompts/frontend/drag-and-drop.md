# Review Vector: Drag and Drop

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/components/**`
**Level**: component

## Context
PageSpace uses @dnd-kit for drag-and-drop interactions including page tree reordering, tab reordering, task list sorting, and file uploads via drop zones. Each drag context must define proper collision detection strategies, handle nested droppable areas without conflicts, and persist reorder results to the server. Drag operations in the page tree are particularly complex because they involve nested hierarchies where dropping a page onto another page can mean either reordering as a sibling or nesting as a child, requiring clear visual indicators and correct intent detection.
