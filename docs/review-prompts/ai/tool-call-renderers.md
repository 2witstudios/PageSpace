# Review Vector: Tool Call Renderers

## Standards
- review.mdc
- javascript.mdc
- please.mdc
- ui.mdc

## Scope
**Files**: `apps/web/src/components/ai/**`
**Level**: component

## Context
Tool call renderers display the results of AI tool invocations inline within the chat, including search results, page previews, file operations, and batch action summaries. Each tool type has a specialized renderer that formats structured data into readable UI. These components must handle loading, error, and partial states gracefully since tool results arrive asynchronously during streaming.
