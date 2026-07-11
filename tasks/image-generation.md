# Image Generation (OpenRouter) — Epic Spec

Canonical repo-side spec (source of truth for file paths). Runnable board:
PageSpace drive **PageSpace** (`lng6q95adrfndmdnnf9z8g6p`) → Features → **Image Generation (OpenRouter)**
epic page `dqofwo4dtu3t8jfcaswec8uu`. Run via `/pu:orchestrate`.

## Goal
Image generation exposed as a **tool** (like read/write/web-search), NOT a model-selector entry, using
OpenRouter image-capable models. **Pro+ gated, off by default.** Every image renders inline in chat AND
is auto-filed as a `FILE` page in a "Generated Images" folder in the user's **Home drive**. User picks the
image model in Settings → AI (dynamic OpenRouter list); enable via composer Tools toggle or Page-AI
`enabledTools`.

## Build mandate
- **Integration branch** `pu/image-gen`; one big PR → master at closeout. Greenfield (no released
  consumers behind Pro+ + default-off toggles) → no compat shims; build target shape directly.
- **TDD strict**, **pure functional core + imperative shell (DI)**, no `any`, bun only, Next.js 15 async
  `params` awaited. One `changelog:generate` pass at closeout.
- **Every impl leaf has a REVIEW leaf**; `/aidd-review` records findings to the review page `## Findings`.
  PR-ralph convergence to `PR_READY` before merge.

## Reference docs (read the real docs)
- OpenRouter image gen: https://openrouter.ai/docs/features/multimodal/image-generation
- OpenRouter models + `architecture.output_modalities`: https://openrouter.ai/api/v1/models
- OpenRouter usage/cost: https://openrouter.ai/docs/use-cases/usage-accounting
- AI SDK v6 generateText/files: https://ai-sdk.dev/docs/ai-sdk-core/generating-text · generateImage: https://ai-sdk.dev/docs/ai-sdk-core/image-generation
- `@openrouter/ai-sdk-provider`: https://github.com/OpenRouterTeam/ai-sdk-provider

## Phases & acceptance criteria (Given X, should Y)

### Phase 1 — Model catalog & capability
- 1-1 `apps/web/src/lib/ai/core/model-capabilities.ts`: `isImageOutputModel` (pure) + `fetchOpenRouterImageModels()` (reads `architecture.output_modalities`, 1h cache, fail-soft `[]`) + `DEFAULT_IMAGE_MODEL`.
- 1-2 `apps/web/src/app/api/ai/image-models/route.ts`: public dynamic list, onprem → `[]`, mirrors `/api/ai/models`.

### Phase 2 — Generation + metering core
- 2-0 SPIKE (throwaway): decide `generateText`+`modalities` vs `generateImage`+`imageModel()`; confirm bytes + `providerMetadata.openrouter.usage.cost`.
- 2-1 `packages/lib/src/billing/credit-pricing.ts`: `IMAGE_GEN_HOLD_CENTS`, pure `resolveImageCost` (`openrouter`|`estimate`), `AI_PRICING` image fallback.
- 2-2 `apps/web/src/lib/ai/core/image-generation.ts`: `generateImageBytes` shell (OpenRouter client injected) → `{ bytes, mediaType, providerCostDollars?, generationIds }`.

### Phase 3 — Storage
- 3-1 `apps/web/src/lib/upload/create-file-page.ts`: `createImageFilePage` (hash→`putObject`→`files`/`pages`FILE/`filePages` tx) + find-or-create Home "Generated Images" FOLDER via `getHomeDrive`. Viewable via `/api/files/[id]/view`, no processor needed. Mirror `upload/complete/route.ts:227-289`.

### Phase 4 — The tool
- 4-1 `apps/web/src/lib/ai/tools/image-generation-tools.ts` (`generate_image`): compose 2-1/2-2/3-1 + `canConsumeAI`/`trackAIUsage`/`releaseHold`; Pro+ defensive check; returns `{ pageId, viewUrl, ... }` (no base64). Register in `ai-tools.ts` `TOOL_MODULES` + `WRITE_TOOLS`; update `tool-registry-docs.test.ts`.

### Phase 5 — Server toggle wiring
- 5-1 `tool-filtering.ts`: `IMAGE_GEN_TOOLS`/`isImageGenTool`/`filterToolsForImageGen` (mirror web_search).
- 5-2 `api/ai/chat/route.ts` + `api/ai/global/[id]/messages/route.ts`: extract/re-add `generate_image` on `imageGenEnabled` + Pro+; thread `imageGenerationModel` into `experimental_context`. Pure "expose?" helper.

### Phase 6 — User settings
- 6-1 `users.imageGenerationModel` (nullable) via `db:generate`; `/api/ai/settings` GET/PATCH + repo, validate against image-model set, Pro+ gate.
- 6-2 `apps/web/src/app/settings/ai/page.tsx`: Pro+ "Image generation" card, Select from `/api/ai/image-models`.

### Phase 7 — Composer UI + client state
- 7-1 `useAssistantSettingsStore.ts` `imageGenEnabled` (localStorage) + `global-chat-request-body.ts` field.
- 7-2 `ToolsPopover.tsx` Image `<Switch>` (Pro+ lock) + `InputFooter`/`GlobalAssistantView` threading.

### Phase 8 — Inline rendering
- 8-1 `generate_image` tool-call renderer (`components/ai/shared/chat/tool-calls/`) — `<img src={viewUrl}>` + lightbox from `ImageMessageContent.tsx`.

### Phase 9 — Gates
- 9-1 Behavior verification E2E (evidence). 9-2 Integration & closeout (big PR, changelog, memory, ship).
