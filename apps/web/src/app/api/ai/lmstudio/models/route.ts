import { NextResponse } from 'next/server';
import { authenticateSessionRequest, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { getUserLMStudioSettings } from '@/lib/ai/core';
import { validateLocalProviderURL } from '@pagespace/lib/security';

/**
 * GET /api/ai/lmstudio/models
 * Discovers available models from user's local LM Studio instance
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateSessionRequest(request);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    // Get user's LM Studio settings
    const lmstudioSettings = await getUserLMStudioSettings(userId);

    if (!lmstudioSettings || !lmstudioSettings.baseUrl) {
      return NextResponse.json({
        success: false,
        error: 'LM Studio not configured. Please configure your LM Studio base URL first.',
        models: {}
      }, { status: 400 });
    }

    // Check if desktop bridge is available for local AI
    const { isFetchBridgeInitialized, getFetchBridge } = await import('@/lib/fetch-bridge');
    const useDesktopBridge = isFetchBridgeInitialized() && getFetchBridge().isUserConnected(userId);

    if (!useDesktopBridge) {
      // SECURITY: Validate URL to prevent SSRF attacks (only for direct server fetch)
      const urlValidation = await validateLocalProviderURL(lmstudioSettings.baseUrl);
      if (!urlValidation.valid) {
        loggers.ai.warn('SSRF protection: blocked LM Studio URL', {
          userId,
          baseUrl: lmstudioSettings.baseUrl,
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
      // Connect to user's LM Studio instance and fetch available models
      // LM Studio uses OpenAI-compatible API at /v1/models
      // When desktop bridge is connected, route through WebSocket to user's machine
      const fetchFn = useDesktopBridge
        ? (await import('@/lib/fetch-bridge/ws-proxy-fetch')).createWsProxyFetch(userId, getFetchBridge())
        : fetch;
      const lmstudioResponse = await fetchFn(`${lmstudioSettings.baseUrl}/models`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(useDesktopBridge ? 10000 : 5000),
      });

      if (!lmstudioResponse.ok) {
        throw new Error(`LM Studio responded with status ${lmstudioResponse.status}`);
      }

      const lmstudioData = await lmstudioResponse.json();

      // Transform LM Studio's response format (OpenAI-compatible) to our expected format
      // LM Studio returns: { data: [{ id: 'model-name' }] }
      const models: Record<string, string> = {};

      if (lmstudioData.data && Array.isArray(lmstudioData.data)) {
        lmstudioData.data.forEach((model: { id?: string; [key: string]: unknown }) => {
          if (model.id) {
            // Use the model ID as both key and display name
            // Clean up the display name for better readability
            const displayName = model.id
              .replace(/_/g, ' ')
              .replace(/-/g, ' ')
              .split(' ')
              .map(word => word.charAt(0).toUpperCase() + word.slice(1))
              .join(' ');
            models[model.id] = displayName;
          }
        });
      }

      loggers.ai.info('Successfully fetched LM Studio models', {
        userId,
        baseUrl: lmstudioSettings.baseUrl,
        modelCount: Object.keys(models).length
      });

      return NextResponse.json({
        success: true,
        models,
        baseUrl: lmstudioSettings.baseUrl,
        modelCount: Object.keys(models).length
      });

    } catch (fetchError) {
      loggers.ai.error('Failed to fetch models from LM Studio', fetchError as Error, {
        userId,
        baseUrl: lmstudioSettings.baseUrl
      });

      // Return empty models - no fallbacks per user preference
      return NextResponse.json({
        success: false,
        error: `Could not connect to LM Studio at ${lmstudioSettings.baseUrl}. Please ensure LM Studio server is running.`,
        models: {},
        baseUrl: lmstudioSettings.baseUrl,
      }, { status: 200 }); // Still return 200 for graceful handling
    }

  } catch (error) {
    loggers.ai.error('LM Studio models discovery error', error as Error);
    return NextResponse.json({
      success: false,
      error: 'Failed to discover LM Studio models',
      models: {}
    }, { status: 500 });
  }
}
