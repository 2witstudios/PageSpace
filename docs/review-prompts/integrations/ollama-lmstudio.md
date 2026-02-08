# Review Vector: Ollama & LM Studio Integration

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- tdd.mdc

## Scope
**Files**: `apps/web/src/app/api/ai/ollama/**`, `apps/web/src/app/api/ai/lmstudio/**`
**Level**: integration

## Context
Local AI model connectivity through Ollama and LM Studio enables offline inference without external API dependencies. Connection handling must gracefully detect when local services are unavailable and surface clear error states rather than hanging or retrying indefinitely. Model listing, health checks, and streaming response parsing should follow the same patterns used by cloud AI providers to maintain a consistent interface across the AI subsystem.
