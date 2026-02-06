# Review Vector: State Management

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/stores/**`, `apps/web/src/hooks/**`, `apps/web/src/components/providers/**`
**Level**: architectural

## Context
Client state is managed through Zustand stores (useAuthStore, useEditingStore, useTabsStore, useLayoutStore, etc.) while server state uses SWR with refresh protection tied to the editing store. Review the division of responsibility between stores, whether SWR and Zustand boundaries are clear, and whether the editing-state protection pattern is consistently applied to prevent UI refreshes during active editing or AI streaming.
