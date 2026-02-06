# Review Vector: Build Canvas Dashboard

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/components/canvas/ShadowCanvas.tsx`, `apps/web/src/app/api/pages/[pageId]/route.ts`, `apps/web/src/hooks/useDashboardContext.ts`, `apps/web/src/hooks/useDocument.ts`, `apps/web/src/stores/useEditingStore.ts`, `apps/web/src/components/editors/MonacoEditor.tsx`, `packages/db/src/schema/dashboard.ts`
**Level**: domain

## Context
The canvas dashboard journey starts when a user creates a canvas page and opens the Monaco code editor to write custom HTML and CSS. The ShadowCanvas component renders the content inside a Shadow DOM for style isolation and security sanitization, preventing XSS while allowing full creative control. Changes are auto-saved through the document hook and persisted to the dashboard schema. This flow crosses the Monaco editor component, Shadow DOM rendering with security sanitization, the document auto-save pipeline with editing store registration, API persistence, and database storage of dashboard content.
