# Review Vector: Chat with AI

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/ai/chat/route.ts`, `apps/web/src/app/api/ai/chat/messages/route.ts`, `apps/web/src/lib/ai/core/provider-factory.ts`, `apps/web/src/lib/ai/core/system-prompt.ts`, `apps/web/src/lib/ai/core/ai-tools.ts`, `apps/web/src/lib/ai/core/conversation-state.ts`, `apps/web/src/lib/ai/core/stream-abort-registry.ts`, `apps/web/src/lib/ai/shared/hooks/useChatTransport.ts`, `apps/web/src/lib/ai/shared/hooks/useStreamingRegistration.ts`, `apps/web/src/components/ai/shared/chat/ChatMessagesArea.tsx`, `apps/web/src/components/ai/shared/chat/StreamingMarkdown.tsx`, `apps/web/src/components/ai/shared/chat/tool-calls/ToolCallRenderer.tsx`, `apps/web/src/app/api/pages/[pageId]/ai-usage/route.ts`, `packages/db/src/schema/ai.ts`
**Level**: domain

## Context
The AI chat journey begins when the user types a message in the chat input, which posts to the chat API route. The route builds a system prompt, resolves the AI provider via the provider factory, attaches available tools, and initiates a streaming response via the Vercel AI SDK. The frontend receives streamed chunks through the transport hook, renders markdown incrementally, and displays tool call results inline. Usage is tracked per-page in the database. This flow crosses the chat UI components, streaming transport, API route handling, AI provider abstraction, tool execution, and usage tracking across multiple database tables.
