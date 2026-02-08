# Review Vector: Vercel AI SDK Integration

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- tdd.mdc
- stack.mdc

## Scope
**Files**: `apps/web/src/lib/ai/**`, `apps/web/src/app/api/ai/**/route.ts`
**Level**: integration

## Context
The Vercel AI SDK provides the unified streaming, tool calling, and multi-provider abstraction layer for all AI interactions in PageSpace. Streaming responses must correctly handle backpressure, client disconnections, and partial tool call results without leaking resources. Provider configuration through OpenRouter, Google AI, Anthropic, and OpenAI adapters should use the provider factory pattern consistently, and tool definitions must match the expected schema for reliable structured output.
