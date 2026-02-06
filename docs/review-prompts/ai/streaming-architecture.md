# Review Vector: Streaming Architecture

## Standards
- review.mdc
- javascript.mdc
- please.mdc
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/ai/**/route.ts`, `apps/web/src/hooks/page-agents/**`
**Level**: domain

## Context
The streaming architecture uses Vercel AI SDK's streamText and streamObject to deliver incremental AI responses to the client via server-sent events. Route handlers must properly configure streaming responses, handle aborts, and manage error states mid-stream. The client-side hooks consume these streams and must coordinate with the editing store to prevent SWR revalidation during active streaming.
