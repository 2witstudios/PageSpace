/**
 * AI Provider Factory Service
 * Centralized provider/model selection logic for all AI routes
 * Eliminates code duplication and provides consistent error handling
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
import { db, users, eq } from '@pagespace/db';
import {
  getUserOpenRouterSettings,
  createOpenRouterSettings,
  getUserGoogleSettings,
  createGoogleSettings,
  getDefaultPageSpaceSettings,
  getUserOpenAISettings,
  createOpenAISettings,
  getUserAnthropicSettings,
  createAnthropicSettings,
  getUserXAISettings,
  createXAISettings,
  getUserOllamaSettings,
  createOllamaSettings,
  getUserGLMSettings,
  createGLMSettings,
} from './ai-utils';

export interface ProviderRequest {
  selectedProvider?: string;
  selectedModel?: string;
  googleApiKey?: string;
  openRouterApiKey?: string;
  openAIApiKey?: string;
  anthropicApiKey?: string;
  xaiApiKey?: string;
  ollamaBaseUrl?: string;
  glmApiKey?: string;
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

/**
 * Creates an AI provider instance with proper configuration and validation
 * Handles all provider types and their specific setup requirements
 */
export async function createAIProvider(
  userId: string,
  request: ProviderRequest
): Promise<ProviderResult | ProviderError> {
  const {
    selectedProvider,
    selectedModel,
    googleApiKey,
    openRouterApiKey,
    openAIApiKey,
    anthropicApiKey,
    xaiApiKey,
    ollamaBaseUrl,
    glmApiKey,
  } = request;

  // Get user's current AI provider settings
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  const currentProvider = selectedProvider || user?.currentAiProvider || 'pagespace';
  const currentModel = selectedModel || user?.currentAiModel || 'GLM-4.5-air';

  try {
    let model;

    if (currentProvider === 'pagespace') {
      // Use default PageSpace settings (now GLM backend or Google AI fallback)
      const pageSpaceSettings = await getDefaultPageSpaceSettings();

      if (!pageSpaceSettings) {
        // Fall back to user's Google settings if no default key
        let googleSettings = await getUserGoogleSettings(userId);

        if (!googleSettings && googleApiKey) {
          await createGoogleSettings(userId, googleApiKey);
          googleSettings = { apiKey: googleApiKey, isConfigured: true };
        }

        if (!googleSettings) {
          return {
            error: 'No default API key configured. Please provide your own Google AI API key.',
            status: 400,
          };
        }

        const googleProvider = createGoogleGenerativeAI({
          apiKey: googleSettings.apiKey,
        });
        model = googleProvider(currentModel);
      } else {
        // Use the appropriate provider based on the configuration
        if (pageSpaceSettings.provider === 'google') {
          const googleProvider = createGoogleGenerativeAI({
            apiKey: pageSpaceSettings.apiKey,
          });
          model = googleProvider(currentModel);
        } else if (pageSpaceSettings.provider === 'glm') {
          // Use GLM provider with OpenAI-compatible endpoint
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
      }
    } else if (currentProvider === 'openrouter') {
      let openRouterSettings = await getUserOpenRouterSettings(userId);

      if (!openRouterSettings && openRouterApiKey) {
        await createOpenRouterSettings(userId, openRouterApiKey);
        openRouterSettings = { apiKey: openRouterApiKey, isConfigured: true };
      }

      if (!openRouterSettings) {
        return {
          error: 'OpenRouter API key not configured. Please provide an API key.',
          status: 400,
        };
      }

      const openrouter = createOpenRouter({
        apiKey: openRouterSettings.apiKey,
      });

      model = openrouter.chat(currentModel);

    } else if (currentProvider === 'openrouter_free') {
      // Handle OpenRouter Free - uses user's OpenRouter key same as regular OpenRouter
      let openRouterSettings = await getUserOpenRouterSettings(userId);

      if (!openRouterSettings && openRouterApiKey) {
        await createOpenRouterSettings(userId, openRouterApiKey);
        openRouterSettings = { apiKey: openRouterApiKey, isConfigured: true };
      }

      if (!openRouterSettings) {
        return {
          error: 'OpenRouter API key not configured. Please provide an API key for free models.',
          status: 400,
        };
      }

      const openrouter = createOpenRouter({
        apiKey: openRouterSettings.apiKey,
      });

      model = openrouter.chat(currentModel);

    } else if (currentProvider === 'google') {
      let googleSettings = await getUserGoogleSettings(userId);

      if (!googleSettings && googleApiKey) {
        await createGoogleSettings(userId, googleApiKey);
        googleSettings = { apiKey: googleApiKey, isConfigured: true };
      }

      if (!googleSettings) {
        return {
          error: 'Google AI API key not configured. Please provide an API key.',
          status: 400,
        };
      }

      const googleProvider = createGoogleGenerativeAI({
        apiKey: googleSettings.apiKey,
      });
      model = googleProvider(currentModel);

    } else if (currentProvider === 'openai') {
      // Handle OpenAI setup
      let openAISettings = await getUserOpenAISettings(userId);

      if (!openAISettings && openAIApiKey) {
        await createOpenAISettings(userId, openAIApiKey);
        openAISettings = { apiKey: openAIApiKey, isConfigured: true };
      }

      if (!openAISettings) {
        return {
          error: 'OpenAI API key not configured. Please provide an API key.',
          status: 400,
        };
      }

      // Create OpenAI provider instance with API key
      const openai = createOpenAI({
        apiKey: openAISettings.apiKey,
      });
      model = openai(currentModel);

    } else if (currentProvider === 'anthropic') {
      // Handle Anthropic setup
      let anthropicSettings = await getUserAnthropicSettings(userId);

      if (!anthropicSettings && anthropicApiKey) {
        await createAnthropicSettings(userId, anthropicApiKey);
        anthropicSettings = { apiKey: anthropicApiKey, isConfigured: true };
      }

      if (!anthropicSettings) {
        return {
          error: 'Anthropic API key not configured. Please provide an API key.',
          status: 400,
        };
      }

      // Create Anthropic provider instance with API key
      const anthropic = createAnthropic({
        apiKey: anthropicSettings.apiKey,
      });
      model = anthropic(currentModel);

    } else if (currentProvider === 'xai') {
      // Handle xAI setup
      let xaiSettings = await getUserXAISettings(userId);

      if (!xaiSettings && xaiApiKey) {
        await createXAISettings(userId, xaiApiKey);
        xaiSettings = { apiKey: xaiApiKey, isConfigured: true };
      }

      if (!xaiSettings) {
        return {
          error: 'xAI API key not configured. Please provide an API key.',
          status: 400,
        };
      }

      // Create xAI provider instance with API key
      const xai = createXai({
        apiKey: xaiSettings.apiKey,
      });
      model = xai(currentModel);

    } else if (currentProvider === 'ollama') {
      // Handle Ollama setup
      let ollamaSettings = await getUserOllamaSettings(userId);

      if (!ollamaSettings && ollamaBaseUrl) {
        await createOllamaSettings(userId, ollamaBaseUrl);
        ollamaSettings = { baseUrl: ollamaBaseUrl, isConfigured: true };
      }

      if (!ollamaSettings) {
        return {
          error: 'Ollama base URL not configured. Please provide a base URL for your local Ollama instance.',
          status: 400,
        };
      }

      // Create Ollama provider instance with base URL
      // Add /api suffix for ollama-ai-provider-v2 which expects full API endpoint
      const ollamaApiUrl = `${ollamaSettings.baseUrl}/api`;
      const ollamaProvider = createOllama({
        baseURL: ollamaApiUrl,
      });
      model = ollamaProvider(currentModel);

    } else if (currentProvider === 'glm') {
      // Handle GLM Coder Plan setup
      let glmSettings = await getUserGLMSettings(userId);

      if (!glmSettings && glmApiKey) {
        await createGLMSettings(userId, glmApiKey);
        glmSettings = { apiKey: glmApiKey, isConfigured: true };
      }

      if (!glmSettings) {
        return {
          error: 'GLM API key not configured. Please configure your GLM Coder Plan API key in Settings > AI.',
          status: 400,
        };
      }

      // Create GLM provider instance using OpenAI-compatible endpoint
      const glmProvider = createOpenAICompatible({
        name: 'glm',
        apiKey: glmSettings.apiKey,
        baseURL: 'https://api.z.ai/api/coding/paas/v4',
      });
      model = glmProvider(currentModel);

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

/**
 * Helper function to create a NextResponse error from ProviderError
 */
export function createProviderErrorResponse(error: ProviderError): NextResponse {
  return NextResponse.json({ error: error.error }, { status: error.status });
}

/**
 * Type guard to check if result is an error
 */
export function isProviderError(result: ProviderResult | ProviderError): result is ProviderError {
  return 'error' in result;
}