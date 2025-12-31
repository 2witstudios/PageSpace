import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import {
  getUserOpenRouterSettings,
  createOpenRouterSettings,
  getUserGoogleSettings,
  createGoogleSettings,
  deleteOpenRouterSettings,
  deleteGoogleSettings,
  getDefaultPageSpaceSettings,
  getUserOpenAISettings,
  createOpenAISettings,
  deleteOpenAISettings,
  getUserAnthropicSettings,
  createAnthropicSettings,
  deleteAnthropicSettings,
  getUserXAISettings,
  createXAISettings,
  deleteXAISettings,
  getUserOllamaSettings,
  createOllamaSettings,
  deleteOllamaSettings,
  getUserLMStudioSettings,
  createLMStudioSettings,
  deleteLMStudioSettings,
  getUserGLMSettings,
  createGLMSettings,
  deleteGLMSettings,
  getUserMiniMaxSettings,
  createMiniMaxSettings,
  deleteMiniMaxSettings,
} from '@/lib/ai/core';
import { aiSettingsRepository } from '@/lib/repositories/ai-settings-repository';
import { requiresProSubscription } from '@/lib/subscription/rate-limit-middleware';

const AUTH_OPTIONS_READ = { allow: ['jwt'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['jwt'] as const, requireCSRF: true };

/**
 * GET /api/ai/settings
 * Returns current AI provider settings and configuration status
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Get user's current provider settings via repository
    const user = await aiSettingsRepository.getUserSettings(userId);
    
    // Check PageSpace default settings
    const pageSpaceSettings = await getDefaultPageSpaceSettings();
    
    // Check OpenRouter settings
    const openRouterSettings = await getUserOpenRouterSettings(userId);
    
    // Check Google AI settings
    const googleSettings = await getUserGoogleSettings(userId);
    
    // Check OpenAI settings
    const openAISettings = await getUserOpenAISettings(userId);
    
    // Check Anthropic settings
    const anthropicSettings = await getUserAnthropicSettings(userId);
    
    // Check xAI settings
    const xaiSettings = await getUserXAISettings(userId);

    // Check Ollama settings
    const ollamaSettings = await getUserOllamaSettings(userId);

    // Check LM Studio settings
    const lmstudioSettings = await getUserLMStudioSettings(userId);

    // Check GLM settings
    const glmSettings = await getUserGLMSettings(userId);

    // Check MiniMax settings
    const minimaxSettings = await getUserMiniMaxSettings(userId);

    return NextResponse.json({
      currentProvider: user?.currentAiProvider || 'pagespace',
      currentModel: user?.currentAiModel || 'glm-4.5-air',
      userSubscriptionTier: user?.subscriptionTier || 'free',
      providers: {
        pagespace: {
          isConfigured: !!pageSpaceSettings?.isConfigured,
          hasApiKey: !!pageSpaceSettings?.apiKey,
        },
        openrouter: {
          isConfigured: !!openRouterSettings?.isConfigured,
          hasApiKey: !!openRouterSettings?.apiKey,
        },
        google: {
          isConfigured: !!googleSettings?.isConfigured,
          hasApiKey: !!googleSettings?.apiKey,
        },
        openai: {
          isConfigured: !!openAISettings?.isConfigured,
          hasApiKey: !!openAISettings?.apiKey,
        },
        anthropic: {
          isConfigured: !!anthropicSettings?.isConfigured,
          hasApiKey: !!anthropicSettings?.apiKey,
        },
        xai: {
          isConfigured: !!xaiSettings?.isConfigured,
          hasApiKey: !!xaiSettings?.apiKey,
        },
        ollama: {
          isConfigured: !!ollamaSettings?.isConfigured,
          hasBaseUrl: !!ollamaSettings?.baseUrl,
        },
        lmstudio: {
          isConfigured: !!lmstudioSettings?.isConfigured,
          hasBaseUrl: !!lmstudioSettings?.baseUrl,
        },
        glm: {
          isConfigured: !!glmSettings?.isConfigured,
          hasApiKey: !!glmSettings?.apiKey,
        },
        minimax: {
          isConfigured: !!minimaxSettings?.isConfigured,
          hasApiKey: !!minimaxSettings?.apiKey,
        },
      },
      isAnyProviderConfigured: !!(pageSpaceSettings?.isConfigured || openRouterSettings?.isConfigured || googleSettings?.isConfigured || openAISettings?.isConfigured || anthropicSettings?.isConfigured || xaiSettings?.isConfigured || ollamaSettings?.isConfigured || lmstudioSettings?.isConfigured || glmSettings?.isConfigured || minimaxSettings?.isConfigured),
    });
  } catch (error) {
    loggers.ai.error('Failed to get AI settings', error as Error);
    return NextResponse.json(
      { error: 'Failed to retrieve settings' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/ai/settings
 * Saves or updates API key for specified provider
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json();
    const { provider, apiKey, baseUrl } = body;

    // Validate input
    if (!provider || !['openrouter', 'google', 'openai', 'anthropic', 'xai', 'ollama', 'lmstudio', 'glm', 'minimax'].includes(provider)) {
      return NextResponse.json(
        { error: 'Invalid provider. Must be "openrouter", "google", "openai", "anthropic", "xai", "ollama", "lmstudio", "glm", or "minimax"' },
        { status: 400 }
      );
    }

    // Validate based on provider type
    if (provider === 'ollama' || provider === 'lmstudio') {
      if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.trim()) {
        return NextResponse.json(
          { error: `Base URL is required for ${provider === 'ollama' ? 'Ollama' : 'LM Studio'}` },
          { status: 400 }
        );
      }
    } else {
      if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
        return NextResponse.json(
          { error: 'API key is required' },
          { status: 400 }
        );
      }
    }

    // Sanitize inputs (remove whitespace)
    const sanitizedApiKey = apiKey?.trim();
    const sanitizedBaseUrl = baseUrl?.trim();

    // Save the API key based on provider
    try {
      if (provider === 'openrouter') {
        await createOpenRouterSettings(userId, sanitizedApiKey);
      } else if (provider === 'google') {
        await createGoogleSettings(userId, sanitizedApiKey);
      } else if (provider === 'openai') {
        await createOpenAISettings(userId, sanitizedApiKey);
      } else if (provider === 'anthropic') {
        await createAnthropicSettings(userId, sanitizedApiKey);
      } else if (provider === 'xai') {
        await createXAISettings(userId, sanitizedApiKey);
      } else if (provider === 'ollama') {
        await createOllamaSettings(userId, sanitizedBaseUrl);
      } else if (provider === 'lmstudio') {
        await createLMStudioSettings(userId, sanitizedBaseUrl);
      } else if (provider === 'glm') {
        await createGLMSettings(userId, sanitizedApiKey);
      } else if (provider === 'minimax') {
        await createMiniMaxSettings(userId, sanitizedApiKey);
      }

      // Return success with minimal information (don't echo back the key/URL)
      const providerName: Record<string, string> = {
        openrouter: 'OpenRouter',
        google: 'Google AI',
        openai: 'OpenAI',
        anthropic: 'Anthropic',
        xai: 'xAI',
        ollama: 'Ollama',
        lmstudio: 'LM Studio',
        glm: 'GLM Coder Plan',
        minimax: 'MiniMax'
      };
      
      return NextResponse.json(
        { 
          success: true,
          provider,
          message: `${providerName[provider]} API key saved successfully`
        },
        { status: 201 }
      );
    } catch (saveError) {
      loggers.ai.error(`Failed to save ${provider} API key`, saveError as Error, { provider });
      return NextResponse.json(
        { error: `Failed to save ${provider} API key` },
        { status: 500 }
      );
    }
  } catch (error) {
    loggers.ai.error('Failed to save API key', error as Error);
    return NextResponse.json(
      { error: 'Failed to save API key' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/ai/settings
 * Updates provider and model selection
 */
export async function PATCH(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json();
    const { provider, model } = body;

    // Validate input - pagespace and openrouter_free are valid providers
    const validProviders = ['pagespace', 'openrouter', 'openrouter_free', 'google', 'openai', 'anthropic', 'xai', 'ollama', 'lmstudio', 'glm', 'minimax'];
    const localProviders = ['ollama', 'lmstudio'];

    if (!provider || !validProviders.includes(provider)) {
      return NextResponse.json(
        { error: 'Invalid provider. Must be "pagespace", "openrouter", "openrouter_free", "google", "openai", "anthropic", "xai", "ollama", "lmstudio", "glm", or "minimax"' },
        { status: 400 }
      );
    }

    // Local providers can have empty model (models discovered dynamically)
    const isLocalProvider = localProviders.includes(provider);
    if (!isLocalProvider && (!model || typeof model !== 'string')) {
      return NextResponse.json(
        { error: 'Model is required' },
        { status: 400 }
      );
    }

    // Get user's subscription tier to check access permissions via repository
    const user = await aiSettingsRepository.getUserSettings(userId);
    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    // Check if user is trying to select PageSpace pro AI model without proper subscription
    if (requiresProSubscription(provider, model, user.subscriptionTier ?? undefined)) {
      return NextResponse.json(
        {
          error: 'Subscription required',
          message: 'PageSpace Pro AI requires a Pro or Business subscription.',
          upgradeUrl: '/settings/billing',
        },
        { status: 403 }
      );
    }

    // Update user's current provider and model selection via repository
    try {
      await aiSettingsRepository.updateProviderSettings(userId, { provider, model });

      return NextResponse.json(
        { 
          success: true,
          provider,
          model,
          message: 'Model selection updated successfully'
        },
        { status: 200 }
      );
    } catch (updateError) {
      loggers.ai.error('Failed to update model selection', updateError as Error, { provider, model });
      return NextResponse.json(
        { error: 'Failed to update model selection' },
        { status: 500 }
      );
    }
  } catch (error) {
    loggers.ai.error('Failed to update settings', error as Error);
    return NextResponse.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/ai/settings
 * Removes API key for specified provider
 */
export async function DELETE(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json();
    const { provider } = body;

    // Validate input
    if (!provider || !['openrouter', 'google', 'openai', 'anthropic', 'xai', 'ollama', 'lmstudio', 'glm', 'minimax'].includes(provider)) {
      return NextResponse.json(
        { error: 'Invalid provider. Must be "openrouter", "google", "openai", "anthropic", "xai", "ollama", "lmstudio", "glm", or "minimax"' },
        { status: 400 }
      );
    }

    // Delete the API key based on provider
    try {
      if (provider === 'openrouter') {
        await deleteOpenRouterSettings(userId);
      } else if (provider === 'google') {
        await deleteGoogleSettings(userId);
      } else if (provider === 'openai') {
        await deleteOpenAISettings(userId);
      } else if (provider === 'anthropic') {
        await deleteAnthropicSettings(userId);
      } else if (provider === 'xai') {
        await deleteXAISettings(userId);
      } else if (provider === 'ollama') {
        await deleteOllamaSettings(userId);
      } else if (provider === 'lmstudio') {
        await deleteLMStudioSettings(userId);
      } else if (provider === 'glm') {
        await deleteGLMSettings(userId);
      } else if (provider === 'minimax') {
        await deleteMiniMaxSettings(userId);
      }

      // Return success with 204 No Content
      return new Response(null, { status: 204 });
    } catch (deleteError) {
      loggers.ai.error(`Failed to delete ${provider} API key`, deleteError as Error, { provider });
      return NextResponse.json(
        { error: `Failed to delete ${provider} API key` },
        { status: 500 }
      );
    }
  } catch (error) {
    loggers.ai.error('Failed to delete API key', error as Error);
    return NextResponse.json(
      { error: 'Failed to delete API key' },
      { status: 500 }
    );
  }
}