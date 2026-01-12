import { loggers } from '@pagespace/lib/server';

const capabilityLogger = loggers.ai.child({ module: 'model-capabilities' });

/**
 * Model Capabilities Detection
 * Identifies which AI models support vision, audio, and other features
 */

/**
 * Map of models that support vision/multimodal capabilities
 * Includes models that can process images, PDFs with images, etc.
 */
const VISION_CAPABLE_MODELS: Record<string, boolean> = {
  // OpenAI GPT-5.2 Models (all have vision)
  'gpt-5.2': true,
  'gpt-5.2-codex': true,
  'gpt-5.2-mini': true,
  'gpt-5.2-nano': true,
  'openai/gpt-5.2': true,
  'openai/gpt-5.2-codex': true,
  'openai/gpt-5.2-mini': true,
  'openai/gpt-5.2-nano': true,

  // OpenAI GPT-5.1 Models (all have vision)
  'gpt-5.1': true,
  'gpt-5.1-codex': true,
  'openai/gpt-5.1': true,
  'openai/gpt-5.1-codex': true,
  'openai/gpt-5.1-codex-mini': true,

  // OpenAI GPT-5 Models (all have vision)
  'gpt-5': true,
  'gpt-5-mini': true,
  'gpt-5-nano': true,
  'gpt-5-2025-08-07': true,
  'gpt-5-chat-latest': true,
  'openai/gpt-5': true,
  'openai/gpt-5-mini': true,
  'openai/gpt-5-nano': true,
  
  // OpenAI GPT-4o Models with Vision
  'gpt-4o': true,
  'gpt-4o-mini': true,
  'gpt-4o-audio-preview': true,
  'gpt-4-turbo': true,
  'gpt-4-turbo-preview': true,
  'gpt-4-vision-preview': true,
  'gpt-4': true,
  'openai/gpt-4o': true,
  'openai/gpt-4o-mini': true,
  'openai/gpt-4-turbo': true,
  'openai/gpt-4': true,
  
  // Anthropic Claude 3+ (all have vision)
  'claude-opus-4-1-20250805': true,
  'claude-sonnet-4-1-20250805': true,
  'claude-3-7-sonnet-20250219': true,
  'claude-3-5-sonnet-20241022': true,
  'claude-3-5-sonnet-20240620': true,
  'claude-3-5-haiku-20241022': true,
  'claude-3-opus-20240229': true,
  'claude-3-sonnet-20240229': true,
  'claude-3-haiku-20240307': true,
  'anthropic/claude-3.5-sonnet': true,
  'anthropic/claude-3-haiku': true,
  'anthropic/claude-opus-4.1': true,
  
  // Google Gemini (all versions support vision)
  'gemini-3-flash-preview': true,
  'gemini-2.5-pro': true,
  'gemini-2.5-flash': true,
  'gemini-2.5-flash-lite': true,
  'gemini-2.0-flash-exp': true,
  'gemini-1.5-pro': true,
  'gemini-1.5-flash': true,
  'google/gemini-3-flash-preview': true,
  'google/gemini-2.5-pro': true,
  'google/gemini-2.5-flash': true,
  'google/gemini-2.5-flash-lite': true,
  'google/gemini-2.5-flash-lite-preview-06-17': true,
  
  // xAI Grok Vision models
  'grok-2-vision': true,
  'grok-2-vision-latest': true,
  'grok-2-vision-1212': true,
  'grok-vision-beta': true,
  'x-ai/grok-4': true, // Grok 4 likely has vision
  
  // Chinese/Asian Vision Models
  'z-ai/glm-4.5v': true, // 'v' suffix indicates vision
  
  // Special handling for o1 models - they DON'T support vision
  'o1': false,
  'o1-mini': false,
  'o1-preview': false,
  'o3': false,
  'o3-mini': false,
  'o4-mini': false,
};

/**
 * Check if a model has vision/multimodal capabilities
 * @param model - The model identifier
 * @returns true if the model supports vision
 */
export function hasVisionCapability(model: string): boolean {
  // Direct lookup first
  if (model in VISION_CAPABLE_MODELS) {
    return VISION_CAPABLE_MODELS[model];
  }
  
  // Check for vision-related keywords in model name
  const lowerModel = model.toLowerCase();
  
  // Explicit vision indicators
  if (lowerModel.includes('vision') || lowerModel.includes('-v-')) {
    return true;
  }
  
  // GPT-5 family (all have vision)
  if (lowerModel.includes('gpt-5')) {
    return true;
  }
  
  // GPT-4o family (omni models have vision)
  if (lowerModel.includes('gpt-4o')) {
    return true;
  }
  
  // Claude 3 and above have vision
  if (lowerModel.includes('claude-3') || lowerModel.includes('claude-4')) {
    return true;
  }
  
  // All Gemini models have vision
  if (lowerModel.includes('gemini')) {
    return true;
  }
  
  // Grok vision models
  if (lowerModel.includes('grok') && lowerModel.includes('vision')) {
    return true;
  }
  
  // Default to false for unknown models
  return false;
}

/**
 * Get a list of suggested vision-capable models for fallback
 * @returns Array of model suggestions
 */
export function getSuggestedVisionModels(): string[] {
  return [
    'gpt-4o-mini',        // Affordable OpenAI option
    'claude-3-haiku',     // Fast Anthropic option
    'gemini-2.5-flash',   // Google's fast option
  ];
}

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