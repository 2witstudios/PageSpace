import { NextResponse } from 'next/server';
import { authenticateSessionRequest, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { getUserOllamaSettings } from '@/lib/ai/core';
import { validateLocalProviderURL } from '@pagespace/lib/security';

/**
 * GET /api/ai/ollama/models
 * Discovers available models from user's local Ollama instance
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateSessionRequest(request);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    // Get user's Ollama settings
    const ollamaSettings = await getUserOllamaSettings(userId);

    if (!ollamaSettings || !ollamaSettings.baseUrl) {
      return NextResponse.json({
        success: false,
        error: 'Ollama not configured. Please configure your Ollama base URL first.',
        models: []
      }, { status: 400 });
    }

    // Check if desktop bridge is available for local AI
    const { isFetchBridgeInitialized, getFetchBridge } = await import('@/lib/fetch-bridge');
    const useDesktopBridge = isFetchBridgeInitialized() && getFetchBridge().isUserConnected(userId);

    // Basic URL format validation applies to both paths
    try { new URL(ollamaSettings.baseUrl); } catch {
      return NextResponse.json({
        success: false,
        error: 'Ollama base URL is not a valid URL.',
        models: {}
      }, { status: 400 });
    }

    if (!useDesktopBridge) {
      // SECURITY: Full SSRF validation for direct server fetch
      const urlValidation = await validateLocalProviderURL(ollamaSettings.baseUrl);
      if (!urlValidation.valid) {
        loggers.ai.warn('SSRF protection: blocked Ollama URL', {
          userId,
          baseUrl: ollamaSettings.baseUrl,
          error: urlValidation.error,
        });
        return NextResponse.json({
          success: false,
          error: 'Invalid URL: blocked for security reasons. Please use a valid, non-internal URL.',
          models: {}
        }, { status: 400 });
      }
    }

    try {
      // Connect to user's Ollama instance and fetch available models
      // When desktop bridge is connected, route through WebSocket to user's machine
      const fetchFn = useDesktopBridge
        ? (await import('@/lib/fetch-bridge/ws-proxy-fetch')).createWsProxyFetch(userId, getFetchBridge())
        : fetch;
      const ollamaResponse = await fetchFn(`${ollamaSettings.baseUrl}/api/tags`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(useDesktopBridge ? 10000 : 5000),
      });

      if (!ollamaResponse.ok) {
        throw new Error(`Ollama responded with status ${ollamaResponse.status}`);
      }

      const ollamaData = await ollamaResponse.json();

      // Transform Ollama's response format to our expected format
      const models: Record<string, string> = {};

      if (ollamaData.models && Array.isArray(ollamaData.models)) {
        ollamaData.models.forEach((model: { name?: string; [key: string]: unknown }) => {
          if (model.name) {
            // Use the model name as both key and display name
            // Remove any size suffix for cleaner display
            const displayName = model.name.replace(/:latest$/, '').replace(/:/g, ' ');
            models[model.name] = displayName.charAt(0).toUpperCase() + displayName.slice(1);
          }
        });
      }

      loggers.ai.info('Successfully fetched Ollama models', {
        userId,
        baseUrl: ollamaSettings.baseUrl,
        modelCount: Object.keys(models).length
      });

      return NextResponse.json({
        success: true,
        models,
        baseUrl: ollamaSettings.baseUrl,
        modelCount: Object.keys(models).length
      });

    } catch (fetchError) {
      loggers.ai.error('Failed to fetch models from Ollama', fetchError as Error, {
        userId,
        baseUrl: ollamaSettings.baseUrl
      });

      // Return fallback models if Ollama is unreachable
      const fallbackModels = {
        'llama3.2:latest': 'Llama 3.2',
        'llama3.2:3b': 'Llama 3.2 3B',
        'llama3.1:latest': 'Llama 3.1 8B',
        'codellama:latest': 'Code Llama',
        'mistral:latest': 'Mistral 7B',
        'qwen2.5:latest': 'Qwen 2.5',
        'qwen2.5-coder:latest': 'Qwen 2.5 Coder',
        'gemma2:latest': 'Gemma 2',
        'phi3:latest': 'Phi-3',
      };

      return NextResponse.json({
        success: false,
        error: `Could not connect to Ollama at ${ollamaSettings.baseUrl}. Using fallback models.`,
        models: fallbackModels,
        baseUrl: ollamaSettings.baseUrl,
        isFallback: true
      }, { status: 200 }); // Still return 200 since we provide fallback models
    }

  } catch (error) {
    loggers.ai.error('Ollama models discovery error', error as Error);
    return NextResponse.json({
      success: false,
      error: 'Failed to discover Ollama models',
      models: {}
    }, { status: 500 });
  }
}