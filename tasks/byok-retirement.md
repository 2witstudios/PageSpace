# BYOK Retirement Epic

**Status**: 📋 PLANNED
**Goal**: Retire user-supplied AI provider keys; route all AI calls through deployment-managed env keys only.

## Overview

Operators (cloud, tenant, onprem) need a single key path so the platform — not each user — owns AI billing, secret rotation, and rate-limit accounting. Per-user BYOK leaks complexity into the UI, the encryption boundary, and the deployment story (especially for self-hosters), and currently bypasses the per-tier daily quota that already gates the `pagespace` virtual provider. This epic removes the user-facing key surface, drops `user_ai_settings`, and extends the existing `incrementUsage` gate to every managed provider.

---

## Managed Provider Resolver

Add an env-backed key resolver in `apps/web/src/lib/ai/core/ai-utils.ts` and rewrite each arm of `createAIProvider` (`apps/web/src/lib/ai/core/provider-factory.ts`) to read from it instead of `getUser<Provider>Settings`.

**Requirements**:
- Given `ANTHROPIC_DEFAULT_API_KEY` is set, should resolve the Anthropic provider with that key without touching the database
- Given a provider whose default key env var is unset on this deployment, should return a 503 from `createAIProvider` so the UI can mark it unavailable
- Given any provider, should never auto-persist a request-body key — the `googleApiKey` / `anthropicApiKey` / etc. fields are removed from `ProviderRequest`
- Given onprem mode and a cloud provider, should keep the existing `isOnPrem()` defense-in-depth reject path even when env keys are absent

---

## Drop `user_ai_settings`

Delete `packages/db/src/schema/ai.ts`, generate a Drizzle drop migration, and purge every `getUser*Settings` / `create*Settings` / `delete*Settings` function from `ai-utils.ts` plus their callers.

**Requirements**:
- Given a fresh `pnpm db:generate` after the schema deletion, should produce a single migration that issues `DROP TABLE user_ai_settings`
- Given `grep userAiSettings packages apps`, should match nothing outside the generated migration SQL
- Given the `users.currentAiProvider` / `users.currentAiModel` columns, should remain unchanged — model selection is not BYOK
- Given `ENCRYPTION_KEY` has remaining consumers elsewhere in the codebase, should leave the env var and `encryption-utils.ts` in place

---

## Settings API Surface

Rewrite `apps/web/src/app/api/ai/settings/route.ts`: kill `POST` and `DELETE`, replace `GET` with a deployment-availability shape, and tighten `PATCH` to reject providers whose env keys are missing.

**Requirements**:
- Given `POST /api/ai/settings` or `DELETE /api/ai/settings`, should return `410 Gone` with a one-line deprecation message
- Given `GET /api/ai/settings`, should return `{ providers: { [name]: { isAvailable: boolean } } }` driven by `getManagedProviderKey`, not by `user_ai_settings` rows
- Given `PATCH /api/ai/settings` with a provider whose managed key is unset on this deployment, should return 503 instead of persisting the selection
- Given `PATCH` with a `pagespace` pro-tier model on a free subscription, should keep returning the existing `requiresProSubscription` 403

---

## Chat Routes: Strip Inline Keys + Broaden Rate Limit

Remove every `*ApiKey` / `*BaseUrl` field from request-body parsing in `apps/web/src/app/api/ai/chat/route.ts` and `apps/web/src/app/api/ai/global/[id]/messages/route.ts`, and extend the rate-limit gate (currently `if (currentProvider === 'pagespace')`) to every managed provider via a new `getProviderTier(provider, model)` helper.

**Requirements**:
- Given a chat request with `anthropicApiKey` in the body, should ignore the field entirely and never write to `user_ai_settings`
- Given a chat call to any managed provider in a billing-enabled mode, should pass through `incrementUsage` and 429 when the per-tier daily quota is exhausted
- Given a chat call in onprem or tenant mode, should still bypass quota enforcement because `getUsageLimits` already returns `-1` when `!isBillingEnabled()`
- Given a model classified as pro-tier (Claude Opus, GPT-5, o3, GLM 5), should be gated by an extended `requiresProSubscription` allowlist

---

## Settings UI: Read-Only Availability View

Replace the 990-line `apps/web/src/app/settings/ai/page.tsx` with a status-only view (no forms, no key inputs) and update `apps/web/src/components/ai/ui/model-selector.tsx` to hide unavailable providers.

**Requirements**:
- Given the AI settings page loads, should render a list of providers with Available / Unavailable badges sourced from `GET /api/ai/settings`
- Given `/settings/ai-api/page.tsx` and its `AiSettingsView` placeholder are now redundant, should delete both routes and any nav references in `SettingsLayoutClient.tsx` / `CenterPanel.tsx`
- Given the model selector renders with a provider whose `isAvailable` is false, should hide that provider's models from the picker
- Given a free-tier user, should hide pro-tier models from the picker without relying on a 403 round-trip

---

## Onprem Operator Config

Wire ollama/lmstudio/azure_openai to deployment env vars (`OLLAMA_BASE_URL`, `LMSTUDIO_BASE_URL`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`) and remove any per-user seeding into `user_ai_settings` from `packages/lib/src/onprem-defaults.ts`.

**Requirements**:
- Given onprem mode with `OLLAMA_BASE_URL` set, should serve Ollama to every user from the operator-configured backend with no per-user URL prompt
- Given onprem mode with `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_ENDPOINT` set, should pass both through `validateLocalProviderURL` for SSRF protection before instantiating the provider
- Given a new onprem user, should not write any row into `user_ai_settings` during default seeding
- Given `.env.example` and `.env.onprem.example`, should document each managed provider's env var alongside `ENCRYPTION_KEY`

---

## Marketing Copy Scrub

Remove every BYOK-as-feature reference from `apps/marketing/`.

**Requirements**:
- Given the pricing page, should render no "Bring Your Own Key" or "BYOK Unlimited" feature row across any tier
- Given `metadata.ts` and `search-data.ts`, should contain no "byok" or "bring your own key" keywords
- Given `schema.tsx`, should describe the Free tier without "BYOK unlimited" copy
- Given the changelog, should include a one-line entry naming the cutover and pointing self-hosters at the new env vars

---
