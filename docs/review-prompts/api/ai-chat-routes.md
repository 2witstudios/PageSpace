# Review Vector: AI Chat Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/ai/chat/**/route.ts`
**Level**: route

## Context
AI chat routes handle the core page-scoped AI conversation: streaming chat completions, message CRUD, message undo/rollback, and abort signaling. These endpoints bridge the Vercel AI SDK with multiple providers (Ollama, OpenRouter, Google, Anthropic) and must correctly manage the message parts structure for multi-modal content. Streaming responses require proper error boundaries so partial failures do not corrupt conversation state. Usage tracking and subscription-tier rate limiting are enforced here.
