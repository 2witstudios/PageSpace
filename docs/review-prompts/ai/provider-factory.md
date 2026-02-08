# Review Vector: Provider Factory

## Standards
- review.mdc
- javascript.mdc
- please.mdc
- stack.mdc

## Scope
**Files**: `apps/web/src/lib/ai/**`
**Level**: service

## Context
The provider factory initializes AI SDK providers (Anthropic, Google, OpenAI, xAI, OpenRouter, Ollama, LMStudio) and maps user-selected models to the correct provider instance. It must handle API key resolution, base URL configuration for local providers, and graceful fallback when a provider is unavailable. Changes here affect every AI interaction in the system, so regressions propagate widely.
