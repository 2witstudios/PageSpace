# Review Vector: TipTap Editor Integration

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- tdd.mdc
- ui.mdc

## Scope
**Files**: `apps/web/src/components/editors/**`, `apps/web/src/lib/editor/**`
**Level**: integration

## Context
The TipTap editor integration provides rich text editing with custom extensions, node views, and markdown serialization for PageSpace documents. Custom extensions must follow TipTap's extension API conventions for schema definition, input rules, and keyboard shortcuts to ensure composability with built-in extensions. Serialization between TipTap's JSON document model and markdown must be bidirectional and lossless for supported node types, and editor state changes must integrate with the editing store to prevent SWR refresh conflicts during active editing.
