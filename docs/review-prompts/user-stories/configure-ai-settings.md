# Review Vector: Configure AI Settings

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/ai/settings/route.ts`, `apps/web/src/app/api/ai/ollama/models/route.ts`, `apps/web/src/app/api/ai/lmstudio/models/route.ts`, `apps/web/src/lib/ai/core/provider-factory.ts`, `apps/web/src/lib/ai/core/model-capabilities.ts`, `apps/web/src/lib/ai/core/ai-providers-config.ts`, `apps/web/src/lib/ai/shared/hooks/useProviderSettings.ts`, `apps/web/src/stores/useAssistantSettingsStore.ts`, `apps/web/src/components/settings/DriveAISettings.tsx`, `apps/web/src/components/ai/chat/input/ProviderModelSelector.tsx`, `packages/db/src/schema/ai.ts`
**Level**: domain

## Context
The AI settings journey begins in the drive settings UI where the user selects a provider (OpenRouter, Ollama, LM Studio, Google, Anthropic, OpenAI, xAI) and model from available options fetched via the model listing endpoints. The settings are saved through the AI settings API and persisted in the database. The provider factory uses these settings to instantiate the correct AI SDK provider at chat time, with model capabilities determining available features like tool calling and streaming. This flow crosses the settings UI components, model discovery APIs for local providers, settings persistence, the Zustand settings store, and the provider factory abstraction that drives all AI interactions.
