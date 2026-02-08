# Review Vector: Create and Edit Document

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/pages/route.ts`, `apps/web/src/app/api/pages/[pageId]/route.ts`, `apps/web/src/components/editors/RichEditor.tsx`, `apps/web/src/components/editors/Toolbar.tsx`, `apps/web/src/hooks/useDocument.ts`, `apps/web/src/stores/useEditingStore.ts`, `apps/web/src/stores/useDocumentStore.ts`, `apps/web/src/stores/useDirtyStore.ts`, `apps/web/src/app/api/activities/route.ts`, `apps/web/src/lib/websocket/ws-connections.ts`, `apps/realtime/src/index.ts`
**Level**: domain

## Context
The journey starts with a POST to the pages API to create a document, then the TipTap-based RichEditor loads and the user begins typing. The useDocument hook manages content state, registers editing state with useEditingStore to prevent SWR refetch conflicts, and triggers auto-save via debounced PATCH requests to the page API. Each save generates an activity log entry and broadcasts changes through the Socket.IO realtime service. This flow touches UI components, editor state management, API routes, database persistence, activity logging, and real-time collaboration broadcasting.
