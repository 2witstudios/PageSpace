/**
 * AI Provider Factory Service
 * Resolves managed provider credentials from deployment env vars and
 * instantiates the appropriate AI SDK client. No per-user keys.
 */

import { NextResponse } from 'next/server';
import { LanguageModel } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createXai } from '@ai-sdk/xai';
import { createOllama } from 'ollama-ai-provider-v2';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { getDefaultPageSpaceSettings, getManagedProviderKey } from './ai-utils';
import { ONPREM_ALLOWED_PROVIDERS, resolvePageSpaceModel } from './ai-providers-config';

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
  const currentProvider = selectedProvider || user?.currentAiProvider || 'pagespace';
  let currentModel = selectedModel || user?.currentAiModel || 'glm-4.7';

  if (currentProvider === 'pagespace') {
    currentModel = resolvePageSpaceModel(currentModel);
  }

  if (
    isOnPrem() &&
    currentProvider !== 'pagespace' &&
    !ONPREM_ALLOWED_PROVIDERS.has(currentProvider)
  ) {
    return {
      error: `Provider "${currentProvider}" is not available in on-premise mode.`,
      status: 403,
    };
  }

  try {
    let model;

    if (currentProvider === 'pagespace') {
      const pageSpaceSettings = await getDefaultPageSpaceSettings();
      if (!pageSpaceSettings) {
        return notConfigured('PageSpace AI');
      }

      if (pageSpaceSettings.provider === 'google') {
        model = createGoogleGenerativeAI({ apiKey: pageSpaceSettings.apiKey })(currentModel);
      } else if (pageSpaceSettings.provider === 'glm') {
        const glmProvider = createOpenAICompatible({
          name: 'glm',
          apiKey: pageSpaceSettings.apiKey,
          baseURL: 'https://api.z.ai/api/coding/paas/v4',
        });
        model = glmProvider(currentModel);
      } else {
        return {
          error: `Unsupported PageSpace provider: ${pageSpaceSettings.provider}`,
          status: 400,
        };
      }
    } else if (currentProvider === 'openrouter' || currentProvider === 'openrouter_free') {
      const managed = getManagedProviderKey(currentProvider);
      if (!managed?.apiKey) return notConfigured('OpenRouter');
      const openrouter = createOpenRouter({ apiKey: managed.apiKey });
      model = openrouter.chat(currentModel);
    } else if (currentProvider === 'google') {
      const managed = getManagedProviderKey('google');
      if (!managed?.apiKey) return notConfigured('Google AI');
      model = createGoogleGenerativeAI({ apiKey: managed.apiKey })(currentModel);
    } else if (currentProvider === 'openai') {
      const managed = getManagedProviderKey('openai');
      if (!managed?.apiKey) return notConfigured('OpenAI');
      model = createOpenAI({ apiKey: managed.apiKey })(currentModel);
    } else if (currentProvider === 'anthropic') {
      const managed = getManagedProviderKey('anthropic');
      if (!managed?.apiKey) return notConfigured('Anthropic');
      model = createAnthropic({ apiKey: managed.apiKey })(currentModel);
    } else if (currentProvider === 'xai') {
      const managed = getManagedProviderKey('xai');
      if (!managed?.apiKey) return notConfigured('xAI');
      model = createXai({ apiKey: managed.apiKey })(currentModel);
    } else if (currentProvider === 'ollama') {
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
    } else if (currentProvider === 'minimax') {
      const managed = getManagedProviderKey('minimax');
      if (!managed?.apiKey) return notConfigured('MiniMax');
      const minimax = createAnthropic({
        apiKey: managed.apiKey,
        baseURL: 'https://api.minimax.io/anthropic/v1',
      });
      model = minimax(currentModel);
    } else {
      return {
        error: `Unsupported AI provider: ${currentProvider}`,
        status: 400,
      };
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
