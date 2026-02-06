# Review Vector: Zustand Stores

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc
- state.mdc

## Scope
**Files**: `apps/web/src/stores/**`
**Level**: component

## Context
PageSpace uses Zustand for all client-side state management across 16+ stores including useEditingStore, useLayoutStore, useTabsStore, useAuthStore, useUIStore, and specialized stores under stores/page-agents/. Stores manage everything from authentication state and document editing to socket connections and multi-select behavior. Correct subscription patterns, selector usage, and avoiding unnecessary re-renders are critical for application performance. Stores also coordinate with SWR data fetching through the editing store's refresh protection mechanism.
