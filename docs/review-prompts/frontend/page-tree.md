# Review Vector: Page Tree

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/components/layout/**`
**Level**: component

## Context
The page tree renders a hierarchical view of pages within a drive, supporting expand/collapse of nested children, drag-and-drop reordering via @dnd-kit, inline rename, and context menu actions. Tree state must synchronize with real-time updates from other users through Socket.IO events and reflect permission-based visibility. The tree can contain hundreds of nodes in active workspaces, so virtualization or efficient rendering strategies matter for responsiveness, especially during drag operations that trigger frequent re-renders.
