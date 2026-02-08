# Review Vector: Document Editor

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- tiptap.mdc
- editor.mdc

## Scope
**Files**: `apps/web/src/components/editors/**`, `apps/web/src/lib/editor/**`, `apps/web/src/hooks/useDocument.ts`
**Level**: domain

## Context
The document editor is built on TipTap with rich text and markdown support, including auto-save and Prettier integration for code formatting. It must register editing state with the useEditingStore to prevent SWR refetch conflicts during active editing. The editor handles content serialization between TipTap JSON and markdown, and coordinates with the realtime service for collaborative editing sessions.
