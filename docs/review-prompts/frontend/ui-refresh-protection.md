# Review Vector: UI Refresh Protection

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/stores/useEditingStore.ts`, `apps/web/src/stores/useDirtyStore.ts`
**Level**: component

## Context
The editing store and dirty store form a critical protection layer that prevents SWR revalidation from clobbering in-progress document edits or AI streaming responses. Components must register editing state via startEditing/endEditing and streaming state via startStreaming/endStreaming, with proper cleanup on unmount. The isEditingActive function is consumed by SWR's isPaused option across the application, and a bug here can cause silent data loss or interrupted AI responses. The hasLoadedRef pattern must always allow the initial fetch through before pausing begins.
