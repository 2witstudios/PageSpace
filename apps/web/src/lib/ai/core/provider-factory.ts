/**
 * AI Provider Factory Service
 * Resolves managed provider credentials from deployment env vars and
 * instantiates the appropriate AI SDK client. No per-user keys.
 *
 * Every cloud vendor (OpenAI, Anthropic, Google, xAI, …) is served through
 * OpenRouter: the model id already carries the vendor prefix and is forwarded
 * verbatim. Local providers (Ollama, LM Studio, Azure OpenAI) keep their own
 * clients for on-prem deployments.
 */

import { NextResponse } from 'next/server';
import { LanguageModel } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOllama } from 'ollama-ai-provider-v2';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { getManagedProviderKey } from './ai-utils';
import { ONPREM_ALLOWED_PROVIDERS, DEFAULT_PROVIDER, DEFAULT_MODEL, isValidModel } from './ai-providers-config';

// The local/on-prem providers (ONPREM_ALLOWED_PROVIDERS = ollama/lmstudio/azure_openai)
// serve runtime-discovered models that aren't in the static catalog, so catalog
// validation is skipped for them — only their provider name is gated.

export interface ProviderRequest {
  selectedProvider?: string;
  selectedModel?: string;
}

export interface ProviderResult {
  model: LanguageModel;
  provider: string;
  modelName: string;
}

export interface ProviderError {
  error: string;
  status: number;
}

function notConfigured(provider: string): ProviderError {
  return {
    error: `${provider} provider is not configured on this deployment.`,
    status: 503,
  };
}

export async function createAIProvider(
  userId: string,
  request: ProviderRequest
): Promise<ProviderResult | ProviderError> {
  const { selectedProvider, selectedModel } = request;

  const [user] = await db.select().from(users).where(eq(users.id, userId));

  // Resolve (provider, model) as one atomic pair — never combine a provider from one
  // source with a model from another. Falling each field back independently
  // (`selectedProvider || stored || default` for each) could synthesize an impossible
  // pair like `anthropic` + the default `openai/…` model when only one field is
  // present, which then silently reroutes to the default below. Prefer the request
  // pair (both present), else the stored pair (both present), else the default pair.
  let currentProvider: string;
  let currentModel: string;
  if (selectedProvider && selectedModel) {
    currentProvider = selectedProvider;
    currentModel = selectedModel;
  } else if (user?.currentAiProvider && user?.currentAiModel) {
    currentProvider = user.currentAiProvider;
    currentModel = user.currentAiModel;
  } else {
    currentProvider = DEFAULT_PROVIDER;
    currentModel = DEFAULT_MODEL;
  }

  // Deployment policy first: on-prem only permits the local/BAA-eligible providers.
  if (
    isOnPrem() &&
    !ONPREM_ALLOWED_PROVIDERS.has(currentProvider)
  ) {
    return {
      error: `Provider "${currentProvider}" is not available in on-premise mode.`,
      status: 403,
    };
  }

  // Catalog enforcement at generation time: any non-local (provider, model) that
  // isn't in AI_PROVIDERS is SUBSTITUTED with the default rather than forwarded.
  // We fall back instead of erroring so that selections left on removed values —
  // a pre-backfill `pagespace`/`glm-*` row, or an agent configured with a bare
  // model id via the raw API — degrade to the working default instead of failing
  // the request. The security goal still holds: an arbitrary/unknown model is
  // never sent to OpenRouter, it resolves to the default. (Explicit invalid
  // *selections* are rejected with a clear 400 at the settings PATCH boundary.)
  // Local providers (ollama/lmstudio/azure) serve runtime-discovered models, so
  // only their provider name is validated (on-prem allowlist + config lookups).
  if (!ONPREM_ALLOWED_PROVIDERS.has(currentProvider) && !isValidModel(currentProvider, currentModel)) {
    currentProvider = DEFAULT_PROVIDER;
    currentModel = DEFAULT_MODEL;
  }

  try {
    let model;

    if (currentProvider === 'ollama') {
      const managed = getManagedProviderKey('ollama');
      if (!managed?.baseUrl) return notConfigured('Ollama');

      try { new URL(managed.baseUrl); } catch {
        return { error: 'Ollama base URL is not a valid URL.', status: 500 };
      }

      const { isFetchBridgeInitialized, getFetchBridge } = await import('@/lib/fetch-bridge');
      const useBridge = isFetchBridgeInitialized() && getFetchBridge().isUserConnected(userId);

      if (!useBridge) {
        const { validateLocalProviderURL } = await import('@pagespace/lib/security/url-validator');
        const ok = await validateLocalProviderURL(managed.baseUrl);
        if (!ok.valid) {
          return { error: `Ollama base URL blocked: ${ok.error}`, status: 500 };
        }
      }

      const ollamaProvider = createOllama({
        baseURL: `${managed.baseUrl}/api`,
        ...(useBridge ? {
          fetch: (await import('@/lib/fetch-bridge/ws-proxy-fetch')).createWsProxyFetch(userId, getFetchBridge()),
        } : {}),
      });
      model = ollamaProvider(currentModel);
    } else if (currentProvider === 'lmstudio') {
      const managed = getManagedProviderKey('lmstudio');
      if (!managed?.baseUrl) return notConfigured('LM Studio');

      try { new URL(managed.baseUrl); } catch {
        return { error: 'LM Studio base URL is not a valid URL.', status: 500 };
      }

      const { isFetchBridgeInitialized: isLmInit, getFetchBridge: getLmBridge } = await import('@/lib/fetch-bridge');
      const useBridge = isLmInit() && getLmBridge().isUserConnected(userId);

      if (!useBridge) {
        const { validateLocalProviderURL } = await import('@pagespace/lib/security/url-validator');
        const ok = await validateLocalProviderURL(managed.baseUrl);
        if (!ok.valid) {
          return { error: `LM Studio base URL blocked: ${ok.error}`, status: 500 };
        }
      }

      const lmstudioProvider = createOpenAICompatible({
        name: 'lmstudio',
        baseURL: managed.baseUrl,
        ...(useBridge ? {
          fetch: (await import('@/lib/fetch-bridge/ws-proxy-fetch')).createWsProxyFetch(userId, getLmBridge()),
        } : {}),
      });
      model = lmstudioProvider(currentModel);
    } else if (currentProvider === 'azure_openai') {
      const managed = getManagedProviderKey('azure_openai');
      if (!managed?.apiKey || !managed?.baseUrl) return notConfigured('Azure OpenAI');

      const { validateLocalProviderURL } = await import('@pagespace/lib/security/url-validator');
      const ok = await validateLocalProviderURL(managed.baseUrl);
      if (!ok.valid) {
        return { error: `Azure OpenAI endpoint URL blocked: ${ok.error}`, status: 500 };
      }

      const azureProvider = createOpenAICompatible({
        name: 'azure_openai',
        apiKey: managed.apiKey,
        baseURL: managed.baseUrl,
      });
      model = azureProvider(currentModel);
    } else if (currentProvider === 'glm') {
      const managed = getManagedProviderKey('glm');
      if (!managed?.apiKey) return notConfigured('GLM Coder Plan');
      const glmProvider = createOpenAICompatible({
        name: 'glm',
        apiKey: managed.apiKey,
        baseURL: 'https://api.z.ai/api/coding/paas/v4',
      });
      model = glmProvider(currentModel);
    } else {
      // Every cloud vendor is served through OpenRouter. The model id already
      // carries its vendor prefix (openai/…, anthropic/…) and is forwarded as-is.
      const managed = getManagedProviderKey('openrouter');
      if (!managed?.apiKey) return notConfigured('OpenRouter');
      // X-OpenRouter-Cache enables OpenRouter's response cache (default 300s TTL):
      // byte-identical repeat requests are served from cache at $0 with zeroed
      // usage. See timestamp-utils.ts — the system-prompt timestamp is bucketed
      // to the cache window so genuine repeats (regenerate/retry) can HIT.
      const openrouter = createOpenRouter({
        apiKey: managed.apiKey,
        // OPENROUTER_BASE_URL lets a non-prod environment (e.g. e2e) redirect the
        // OpenRouter API at a deterministic stub that returns known usage.cost, so
        // billing can be asserted end-to-end. Unset in prod → real OpenRouter.
        ...(process.env.OPENROUTER_BASE_URL ? { baseURL: process.env.OPENROUTER_BASE_URL } : {}),
        headers: { 'X-OpenRouter-Cache': 'true' },
      });
      // usage: { include: true } turns on OpenRouter usage accounting so the
      // response carries the authoritative per-request cost under
      // providerMetadata.openrouter.usage.cost — the basis we bill on (see
      // extractOpenRouterCostDollars / trackAIUsage). Without it, cost is undefined.
      //
      // extraBody.provider is OpenRouter request-body provider routing (merged into
      // the request body by the SDK):
      //   require_parameters: true — only route to upstream providers that actually
      //     honor every param we send (notably `tools`). A provider that silently
      //     ignores tools can never call the `finish` tool, which is a root cause of
      //     "agent runs tools then never finishes". This forces tool-capable routing.
      //   allow_fallbacks: true — keep OpenRouter's automatic failover to the next
      //     healthy provider when one errors, reducing mid-stream disconnects.
      model = openrouter.chat(currentModel, {
        usage: { include: true },
        extraBody: {
          provider: {
            require_parameters: true,
            allow_fallbacks: true,
          },
        },
      });
    }

    return {
      model,
      provider: currentProvider,
      modelName: currentModel,
    };
  } catch (error) {
    console.error('Error creating AI provider:', error);
    return {
      error: 'Failed to initialize AI provider. Please check your settings and try again.',
      status: 500,
    };
  }
}

/**
 * Updates user's current provider and model settings if they've changed
 */
export async function updateUserProviderSettings(
  userId: string,
  selectedProvider?: string,
  selectedModel?: string
): Promise<void> {
  if (!selectedProvider || !selectedModel) return;

  const [user] = await db.select().from(users).where(eq(users.id, userId));

  if (selectedProvider !== user?.currentAiProvider || selectedModel !== user?.currentAiModel) {
    await db
      .update(users)
      .set({
        currentAiProvider: selectedProvider,
        currentAiModel: selectedModel,
      })
      .where(eq(users.id, userId));
  }
}

export function createProviderErrorResponse(error: ProviderError): NextResponse {
  return NextResponse.json({ error: error.error }, { status: error.status });
}

export function isProviderError(result: ProviderResult | ProviderError): result is ProviderError {
  return 'error' in result;
}
