# Review Vector: Tab System

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/stores/useTabsStore.ts`, `apps/web/src/stores/useOpenTabsStore.ts`, `apps/web/src/lib/tabs/**`
**Level**: component

## Context
PageSpace implements a browser-like tab system with two Zustand stores: useTabsStore for tab metadata and ordering, and useOpenTabsStore for tracking which tabs are currently open. The lib/tabs/ directory contains tab lifecycle logic including opening, closing, reordering, and restoring tabs from persisted state. Tabs must coordinate with the router for navigation, handle dirty state warnings before closing unsaved documents, and support drag-and-drop reordering in the tab bar.
