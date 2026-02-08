# Review Vector: Tool Calling System

## Standards
- review.mdc
- javascript.mdc
- please.mdc

## Scope
**Files**: `apps/web/src/lib/ai/**`
**Level**: service

## Context
The tool calling system defines PageSpace tools (search, page operations, file management, batch operations), validates tool call arguments, executes them against the backend, and formats results for the AI model. Tool definitions must match Vercel AI SDK's schema format and handle partial/streaming tool calls. Security is critical since tool execution performs real mutations on user data.
