import { NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth-utils';
import { loggers } from '@pagespace/lib/logger-config';
import { getUserOllamaSettings } from '@/lib/ai/ai-utils';

/**
 * GET /api/ai/ollama/models
 * Discovers available models from user's local Ollama instance
 */
export async function GET(request: Request) {
  try {
    const { userId, error } = await authenticateRequest(request);
    if (error) return error;

    // Get user's Ollama settings
    const ollamaSettings = await getUserOllamaSettings(userId);

    if (!ollamaSettings || !ollamaSettings.baseUrl) {
      return NextResponse.json({
        success: false,
        error: 'Ollama not configured. Please configure your Ollama base URL first.',
        models: []
      }, { status: 400 });
    }

    try {
      // Connect to user's Ollama instance and fetch available models
      const ollamaResponse = await fetch(`${ollamaSettings.baseUrl}/api/tags`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        // Add timeout to prevent hanging
        signal: AbortSignal.timeout(5000), // 5 second timeout
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