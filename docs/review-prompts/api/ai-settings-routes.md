# Review Vector: AI Settings Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/ai/settings/**`, `apps/web/src/app/api/ai/ollama/**`, `apps/web/src/app/api/ai/lmstudio/**`
**Level**: route

## Context
These routes manage AI provider configuration: saving and retrieving user AI preferences, listing available Ollama models from the local instance, and listing LM Studio models. The settings endpoint stores provider selection, model preferences, and API keys. Ollama and LM Studio model-listing endpoints proxy requests to local services and must handle connection failures gracefully. API key storage requires proper encryption at rest and must never return raw keys in GET responses.
