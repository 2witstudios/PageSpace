import { loggers } from '@pagespace/lib/logging/logger-config';
import { hasVisionCapability } from './vision-models';
import { getBackendProvider, AI_PROVIDERS } from './ai-providers-config';

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
const temperatureCapabilityCache = new Map<string, boolean>();
const openRouterModelsCache = new Map<string, boolean>();
// Tracks which OpenRouter models list 'temperature' in supported_parameters.
// Populated in the same fetch as openRouterModelsCache — no second API call.
const openRouterTemperatureCache = new Map<string, boolean>();
let openRouterCacheExpiry = 0;

/**
 * OpenRouter model data interface
 */
interface OpenRouterModel {
  id: string;
  name?: string;
  supported_parameters?: string[];
  /** OpenRouter reports input/output modalities under `architecture`. */
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
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
      openRouterTemperatureCache.set(model.id, model.supported_parameters?.includes('temperature') ?? false);
    });

    // Set cache expiry to 1 hour from now
    openRouterCacheExpiry = now + (60 * 60 * 1000);

    capabilityLogger.debug('Cached OpenRouter tool capability metadata', {
      modelCount: openRouterModelsCache.size,
    });
    return openRouterModelsCache;
  } catch (error) {
    capabilityLogger.warn('Failed to fetch OpenRouter model capabilities', { error: error instanceof Error ? error.message : String(error) });
    // Return empty map on error, fallback to runtime discovery
    return new Map();
  }
}

/**
 * Default image-generation model — an image-output model present in the curated
 * catalog (see AI_PROVIDERS). Used when a user hasn't chosen one.
 */
export const DEFAULT_IMAGE_MODEL = 'google/gemini-3.1-flash-image-preview';

/**
 * Pure: does this OpenRouter model emit images? True when its
 * `architecture.output_modalities` includes `"image"`.
 */
export function isImageOutputModel(model: OpenRouterModel): boolean {
  return model.architecture?.output_modalities?.includes('image') ?? false;
}

/** A minimal image-model descriptor for pickers/routes (no pricing). */
export interface ImageModelInfo {
  id: string;
  displayName: string;
}

// Cache of image-capable models (1h TTL), populated from the same /api/v1/models payload.
let imageModelsCache: ImageModelInfo[] = [];
let imageModelsCacheExpiry = 0;

/** Resolve a display name for a model id: curated catalog → OpenRouter name → id. */
function resolveImageModelDisplayName(id: string, orName?: string): string {
  for (const provider of Object.values(AI_PROVIDERS)) {
    const models = provider.models as Record<string, string>;
    if (models[id]) return models[id];
  }
  return orName ?? id;
}

/**
 * Fetch the set of OpenRouter image-output models (`architecture.output_modalities`
 * includes `"image"`), as `{ id, displayName }` sorted stably by id. Fail-soft: returns
 * `[]` on any fetch error (never throws). Cached for 1 hour, mirroring
 * {@link fetchOpenRouterToolCapabilities}.
 */
export async function fetchOpenRouterImageModels(): Promise<ImageModelInfo[]> {
  const now = Date.now();
  if (imageModelsCacheExpiry > now && imageModelsCache.length > 0) {
    return imageModelsCache;
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/models');
    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }
    const data = await response.json();
    const models = (data.data as OpenRouterModel[]) ?? [];

    imageModelsCache = models
      .filter(isImageOutputModel)
      .map((m) => ({ id: m.id, displayName: resolveImageModelDisplayName(m.id, m.name) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    imageModelsCacheExpiry = now + 60 * 60 * 1000;

    capabilityLogger.debug('Cached OpenRouter image-model metadata', {
      modelCount: imageModelsCache.length,
    });
    return imageModelsCache;
  } catch (error) {
    capabilityLogger.warn('Failed to fetch OpenRouter image models', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
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

  // For OpenRouter-backed cloud vendors, check their API for authoritative data
  if (getBackendProvider(provider) === 'openrouter') {
    try {
      const openRouterCapabilities = await fetchOpenRouterToolCapabilities();
      const hasTools = openRouterCapabilities.get(model) || false;
      toolCapabilityCache.set(cacheKey, hasTools);
      return hasTools;
    } catch (error) {
      capabilityLogger.warn(`Failed to check OpenRouter capability for ${model}`, { error: error instanceof Error ? error.message : String(error) });
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

// Known reasoning model bare IDs for non-OpenRouter providers (e.g. direct openai).
// These models reject the temperature parameter entirely.
const NON_TEMPERATURE_MODELS = new Set([
  'o1', 'o1-mini', 'o1-preview', 'o1-pro',
  'o3', 'o3-mini', 'o3-pro',
  'o4-mini',
  'deepseek-r1', 'deepseek-r1-0528',
]);

/** Strip provider prefix for bare-ID lookups (e.g. "openai/o3" → "o3") */
const stripModelPrefix = (model: string): string => {
  const idx = model.indexOf('/');
  return idx >= 0 ? model.slice(idx + 1) : model;
};

/**
 * Returns false for reasoning/thinking models that reject the temperature parameter.
 * For OpenRouter-backed providers this is authoritative (from supported_parameters).
 * For direct providers, falls back to a static set + name-based patterns.
 */
export async function supportsTemperature(model: string, provider: string): Promise<boolean> {
  const cacheKey = `${provider}:${model}`;
  if (temperatureCapabilityCache.has(cacheKey)) {
    return temperatureCapabilityCache.get(cacheKey)!;
  }

  if (getBackendProvider(provider) === 'openrouter') {
    // fetchOpenRouterToolCapabilities swallows its own errors and returns an empty map,
    // so this try/catch only guards against unexpected throws. When the fetch fails the
    // cache stays empty and we fall through to static detection below — which correctly
    // blocks known reasoning models even during an OpenRouter outage.
    try {
      await fetchOpenRouterToolCapabilities(); // populates openRouterTemperatureCache
    } catch {
      // fall through to static detection
    }
    if (openRouterTemperatureCache.has(model)) {
      const result = openRouterTemperatureCache.get(model)!;
      temperatureCapabilityCache.set(cacheKey, result);
      return result;
    }
    // Model not in OpenRouter cache (API unavailable or truly unknown model).
    // Fall through to static detection so known reasoning model IDs are still blocked.
  }

  const bare = stripModelPrefix(model);

  if (NON_TEMPERATURE_MODELS.has(bare)) {
    temperatureCapabilityCache.set(cacheKey, false);
    return false;
  }

  // Pattern-based: -thinking suffix, -r1 suffix, or o1/o3/o4 prefix
  const lower = bare.toLowerCase();
  if (lower.includes('-thinking') || lower.includes('-r1') ||
      lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) {
    temperatureCapabilityCache.set(cacheKey, false);
    return false;
  }

  temperatureCapabilityCache.set(cacheKey, true);
  return true;
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