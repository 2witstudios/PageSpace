# OpenRouter Free — Dynamic Model List Epic

**Status**: ✅ COMPLETED (2026-05-23)
**Goal**: Replace the hardcoded `openrouter_free` model list with a live fetch from the OpenRouter API, following the existing ollama/lmstudio pattern.

## Overview

The `openrouter_free` provider has a static model list that drifts out of date as OpenRouter adds and removes free-tier models. Ollama and LM Studio already solve this with a dynamic fetch pattern (`/api/ai/ollama/models`, `/api/ai/lmstudio/models`). This epic applies the same pattern to `openrouter_free`: a server-side route that fetches from `https://openrouter.ai/api/v1/models`, filters for `:free` models with zero pricing, caches for 1 hour via Next.js `fetch` revalidation, and returns the same `{ success, models }` shape the UI already knows how to consume.

---

## Add OpenRouter free models API route

Create `apps/web/src/app/api/ai/openrouter/models/route.ts` mirroring the lmstudio route shape.

**Requirements**:
- Given a GET request, should authenticate the session before fetching
- Given a valid session, should fetch `https://openrouter.ai/api/v1/models` using the managed `openrouter` API key via `getManagedProviderKey('openrouter')`, with `next: { revalidate: 3600 }` for 1h server-side cache
- Given the OpenRouter response, should filter to models where `id.endsWith(':free')` AND `pricing.prompt === '0'`
- Given filtered models, should return `{ success: true, models: Record<string, string> }` where the key is the model ID and the value is the model `name` field from the API
- Given OpenRouter is not configured, should return `{ success: false, error: '...', models: {} }` with status 503
- Given a fetch failure, should return `{ success: false, error: '...', models: {} }` with status 200 (graceful, same as lmstudio)

---

## Wire dynamic models into ProviderModelSelector

Update `apps/web/src/components/ai/chat/input/ProviderModelSelector.tsx` to fetch and render `openrouter_free` models dynamically.

**Requirements**:
- Given the component mounts with `provider === 'openrouter_free'`, should fetch `/api/ai/openrouter/models` on first render (same lazy pattern as `fetchOllamaModels`)
- Given fetched models, should store in `openrouter_freeModels` state (mirrors `ollamaModels` / `lmstudioModels`)
- Given `provider === 'openrouter_free'` and a known model ID, should resolve the display name from `openrouter_freeModels` before falling back to `getModelDisplayName`
- Given the settings-updated event fires, should clear `openrouter_freeModels` so the list refetches
- Given `provider === 'openrouter_free'` and models are loading, should show the same loading indicator already used for ollama/lmstudio

---

## Remove static openrouter_free model list

Update `apps/web/src/lib/ai/core/ai-providers-config.ts` to replace the static models object with an empty one.

**Requirements**:
- Given `openrouter_free` config, should have `models: {}` so the UI falls back to the dynamic fetch exclusively
- Given any existing test that references specific `openrouter_free` model IDs from the config, should be updated to reflect the empty static list
