# Integration: @dnd-kit

This document outlines how pagespace uses `@dnd-kit` to implement drag-and-drop functionality, primarily for reordering pages in the sidebar tree view.

## Overview

`@dnd-kit` is a modern, lightweight, and accessible toolkit for building drag-and-drop interfaces in React. We use it to provide a smooth, intuitive, and feature-rich page reordering experience, including nesting pages within each other.

The core implementation is located within the page tree components:
-   **Context Provider:** [`apps/web/src/components/layout/left-sidebar/page-tree/PageTree.tsx`](apps/web/src/components/layout/left-sidebar/page-tree/PageTree.tsx:1)
-   **Draggable Items:** [`apps/web/src/components/layout/left-sidebar/page-tree/TreeNode.tsx`](apps/web/src/components/layout/left-sidebar/page-tree/TreeNode.tsx:1)

## Core Concepts & Implementation

Our implementation relies on a few key components and concepts from `@dnd-kit`.

### 1. `DndContext`

The entire page tree is wrapped in a `DndContext` provider within [`PageTree.tsx`](apps/web/src/components/layout/left-sidebar/page-tree/PageTree.tsx:1). This component is the heart of the drag-and-drop system, managing sensors, collision detection, and event handlers.

-   **Sensors:** We use a `PointerSensor` with an `activationConstraint` of 8px. This means a user must drag an item at least 8 pixels before a drag operation begins, which prevents accidental drags when clicking.
-   **Event Handlers:** The context is configured with three main event handlers: `onDragStart`, `onDragOver`, and `onDragEnd`, which manage the entire lifecycle of the drag.

### 2. `SortableContext` and `useSortable`

-   **`SortableContext`:** Each level of the tree (both the root and the children of any expanded folder) is wrapped in a `SortableContext`. This provides the context for the `useSortable` hook and defines the sorting strategy (`verticalListSortingStrategy`).
-   **`useSortable`:** The [`TreeNode`](apps/web/src/components/layout/left-sidebar/page-tree/TreeNode.tsx:1) component uses the `useSortable` hook. This hook does the heavy lifting of making a component draggable, providing the necessary `attributes`, `listeners`, and `transform` properties to apply to the DOM node.

```tsx
// apps/web/src/components/layout/left-sidebar/page-tree/TreeNode.tsx
const {
  attributes,
  listeners,
  setNodeRef,
  transform,
  transition,
} = useSortable({ id: node.id });

const style = {
  transform: CSS.Transform.toString(transform),
  transition,
};

return (
  <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
    {/* ... node content ... */}
  </div>
);
```

### 3. `DragOverlay`

To provide a clean and visually distinct preview of the item being dragged, we use the `DragOverlay` component. When a drag begins, we render a custom [`DragOverlayItem`](apps/web/src/components/layout/left-sidebar/page-tree/DragOverlayItem.tsx:1) component inside it. This is preferable to dragging a semi-transparent "ghost" of the original item.

## The Drag-and-Drop Lifecycle

The entire logic for reordering is handled by the event handlers in [`PageTree.tsx`](apps/web/src/components/layout/left-sidebar/page-tree/PageTree.tsx:1).

### `onDragStart`

-   When a drag begins, this function is called.
-   Its only job is to set the `activeId` state variable to the ID of the node that is being dragged. This is used to render the `DragOverlay`.

### `onDragOver`

-   This function is called continuously as the user drags an item over other items.
-   It performs the crucial logic of determining where the item will be dropped:
    -   If the user drags horizontally (`delta.x > 30`), the `dropPosition` is set to `"inside"`, indicating the item will be nested.
    -   Otherwise, it checks the vertical position (`delta.y`) to determine if the `dropPosition` is `"before"` or `"after"` the item being hovered over.
-   The `dragState` (containing `overId` and `dropPosition`) is used by the `TreeNode` components to render visual drop indicators (the blue lines and highlight boxes).

### `onDragEnd`

-   This function is called when the user releases the mouse button, finalizing the drop.
-   **Optimistic Update:** It first calculates the new structure of the page tree and updates a local `optimisticTree` state variable. This provides immediate visual feedback to the user, making the UI feel instantaneous.
-   **API Call:** It then calculates the new `position` of the dragged page based on its new siblings and sends a `PATCH` request to the `/api/pages/reorder` endpoint with the `pageId`, `newParentId`, and `newPosition`.
-   **Finalization & Reversion:**
    -   If the API call is successful, it calls `mutate()` from SWR to re-fetch the official page tree from the server, ensuring the UI is in sync with the database.
    -   If the API call fails, it reverts the change by setting `optimisticTree` back to `null`.
    -   Finally, it resets all drag-related state variables (`activeId`, `dragState`, `optimisticTree`).
**Last Updated:** 2025-08-13