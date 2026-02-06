# Review Vector: Left Sidebar

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/components/layout/**`
**Level**: component

## Context
The left sidebar contains the drive list, page tree with nested expand/collapse behavior, favorites, and navigation controls. It supports drag-and-drop reordering of pages within the tree, keyboard navigation, and responsive collapse on mobile via useLayoutStore. The sidebar must stay open when selecting a drive from favorites (a recently fixed bug) and correctly reflect real-time updates when other users modify the page tree. Performance is important since the tree can be deeply nested with many nodes.
