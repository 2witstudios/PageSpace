import { loggers } from '@pagespace/lib/server';

const capabilityLogger = loggers.ai.child({ module: 'model-capabilities' });

// Re-export vision detection from client-safe module
export { hasVisionCapability, getSuggestedVisionModels } from './vision-models';

/**
 * Known problematic models that don't support tools
 * Keep this list minimal - only for models we know cause issues
 */
const NON_TOOL_CAPABLE_MODELS: Record<string, boolean> = {
  // Gemma family generally lacks tool support
  'gemma:1b': false,
  'gemma:2b': false,
  'gemma:7b': false,
  'gemma2:2b': false,
  'gemma2:9b': false,
  'gemma3:1b': false,
  'gemma3:2b': false,
  // Add other known problematic models as discovered
};

/**
 * Cache for tool capability detection to avoid repeated API calls and errors
 */
const toolCapabilityCache = new Map<string, boolean>();
const openRouterModelsCache = new Map<string, boolean>();
let openRouterCacheExpiry = 0;

/**
 * OpenRouter model data interface
 */
interface OpenRouterModel {
  id: string;
  supported_parameters?: string[];
}

/**
 * Fetch tool capabilities from OpenRouter API
 * @returns Map of model IDs to tool support status
 */
async function fetchOpenRouterToolCapabilities(): Promise<Map<string, boolean>> {
  const now = Date.now();

  // Return cached data if still valid (cache for 1 hour)
  if (openRouterCacheExpiry > now && openRouterModelsCache.size > 0) {
    return openRouterModelsCache;
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/models');
    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json();
    const models = data.data as OpenRouterModel[];

    // Clear and rebuild cache
    openRouterModelsCache.clear();

    models.forEach(model => {
      const hasTools = model.supported_parameters?.includes('tools') &&
                      model.supported_parameters?.includes('tool_choice');
      openRouterModelsCache.set(model.id, hasTools || false);
    });

    // Set cache expiry to 1 hour from now
    openRouterCacheExpiry = now + (60 * 60 * 1000);

    capabilityLogger.debug('Cached OpenRouter tool capability metadata', {
      modelCount: openRouterModelsCache.size,
    });
    return openRouterModelsCache;
  } catch (error) {
    capabilityLogger.warn('Failed to fetch OpenRouter model capabilities', error instanceof Error ? error : undefined);
    // Return empty map on error, fallback to runtime discovery
    return new Map();
  }
}

/**
 * Check if a model supports tool/function calling
 * @param model - The model identifier
 * @param provider - The provider name
 * @returns Promise<boolean> - true if the model supports tools
 */
export async function hasToolCapability(model: string, provider: string): Promise<boolean> {
  const cacheKey = `${provider}:${model}`;

  // Check runtime cache first
  if (toolCapabilityCache.has(cacheKey)) {
    return toolCapabilityCache.get(cacheKey)!;
  }

  // Check static overrides for known problematic models
  const staticResult = NON_TOOL_CAPABLE_MODELS[model];
  if (staticResult === false) {
    toolCapabilityCache.set(cacheKey, false);
    return false;
  }

  // For OpenRouter, check their API for authoritative data
  if (provider === 'openrouter' || provider === 'openrouter_free') {
    try {
      const openRouterCapabilities = await fetchOpenRouterToolCapabilities();
      const hasTools = openRouterCapabilities.get(model) || false;
      toolCapabilityCache.set(cacheKey, hasTools);
      return hasTools;
    } catch (error) {
      capabilityLogger.warn(`Failed to check OpenRouter capability for ${model}`, error instanceof Error ? error : undefined);
      // Fall through to default behavior
    }
  }

  // For other providers, apply pattern-based detection
  const lowerModel = model.toLowerCase();

  // Gemma models generally don't support tools
  if (lowerModel.includes('gemma')) {
    toolCapabilityCache.set(cacheKey, false);
    return false;
  }

  // Most modern models support tools, so default to true
  // This allows runtime discovery to work
  toolCapabilityCache.set(cacheKey, true);
  return true;
}

/**
 * Get suggested tool-capable models for fallback
 * @param provider - Current provider
 * @returns Array of model suggestions
 */
export function getSuggestedToolCapableModels(provider: string): string[] {
  switch (provider) {
    case 'ollama':
      return ['llama3.1:8b', 'qwen2.5:7b', 'mistral:7b'];
    case 'openrouter':
    case 'openrouter_free':
      return ['meta-llama/llama-3.1-8b-instruct', 'qwen/qwen-2.5-7b-instruct'];
    case 'google':
      return ['gemini-2.5-flash', 'gemini-1.5-flash'];
    case 'openai':
      return ['gpt-4o-mini', 'gpt-3.5-turbo'];
    case 'anthropic':
      return ['claude-3-haiku', 'claude-3-5-sonnet'];
    default:
      return ['gpt-4o-mini', 'claude-3-haiku', 'gemini-2.5-flash'];
  }
}

/**
 * Model capabilities interface
 */
export interface ModelCapabilities {
  hasVision: boolean;
  hasTools: boolean;
  model: string;
  provider: string;
}

/**
 * Get full capabilities for a model
 * @param model - The model identifier
 * @param provider - The provider name
 * @returns Promise<ModelCapabilities> - Model capabilities object
 */
export async function getModelCapabilities(model: string, provider: string): Promise<ModelCapabilities> {
  const [hasVision, hasTools] = await Promise.all([
    Promise.resolve(hasVisionCapability(model)),
    hasToolCapability(model, provider)
  ]);

  return {
    hasVision,
    hasTools,
    model,
    provider,
  };
}