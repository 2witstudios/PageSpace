/**
 * Vision model capability detection.
 * This module is safe for client-side use — no server-only imports.
 * Server-side code should use model-capabilities.ts which re-exports these.
 */

const VISION_CAPABLE_MODELS: Record<string, boolean> = {
  // OpenAI GPT-5.4 Models (all have vision)
  'gpt-5.4-pro': true,
  'gpt-5.4': true,

  // OpenAI GPT-5.3 Models (all have vision)
  'gpt-5.3-chat-latest': true,
  'gpt-5.3-codex': true,

  // OpenAI GPT-5.2 Models (all have vision)
  'gpt-5.2': true,
  'gpt-5.2-codex': true,
  'gpt-5.2-mini': true,
  'gpt-5.2-nano': true,

  // OpenAI GPT-5.1 Models (all have vision)
  'gpt-5.1': true,
  'gpt-5.1-codex': true,

  // OpenAI GPT-5 Models (all have vision)
  'gpt-5': true,
  'gpt-5-mini': true,
  'gpt-5-nano': true,

  // OpenAI GPT-4.1 Models (all have vision)
  'gpt-4.1-2025-04-14': true,
  'gpt-4.1-mini-2025-04-14': true,
  'gpt-4.1-nano-2025-04-14': true,

  // OpenAI GPT-4o Models with Vision
  'gpt-4o': true,
  'gpt-4o-mini': true,
  'gpt-4o-audio-preview': true,
  'gpt-4-turbo': true,
  'gpt-4-turbo-preview': true,
  'gpt-4-vision-preview': true,
  'gpt-4': true,

  // Anthropic Claude 3+ (all have vision)
  'claude-opus-4-6-20260204': true,
  'claude-sonnet-4-6-20260217': true,
  'claude-opus-4.6': true,
  'claude-sonnet-4.6': true,
  'claude-opus-4-5-20251124': true,
  'claude-sonnet-4-5-20250929': true,
  'claude-haiku-4-5-20251001': true,
  'claude-opus-4.5': true,
  'claude-sonnet-4.5': true,
  'claude-haiku-4.5': true,
  'claude-opus-4-1-20250805': true,
  'claude-sonnet-4-1-20250805': true,
  'claude-opus-4.1': true,
  'claude-3-7-sonnet-20250219': true,
  'claude-3-5-sonnet-20241022': true,
  'claude-3-5-sonnet-20240620': true,
  'claude-3-5-haiku-20241022': true,
  'claude-3-opus-20240229': true,
  'claude-3-sonnet-20240229': true,
  'claude-3-haiku-20240307': true,

  // Google Gemini (all versions support vision)
  'gemini-3.1-pro-preview': true,
  'gemini-3.1-pro-preview-customtools': true,
  'gemini-3.1-flash-lite-preview': true,
  'gemini-3-flash-preview': true,
  'gemini-2.5-pro': true,
  'gemini-2.5-flash': true,
  'gemini-2.5-flash-lite': true,
  'gemini-2.5-flash-lite-preview-06-17': true,
  'gemini-2.0-flash-exp': true,
  'gemini-1.5-pro': true,
  'gemini-1.5-flash': true,

  // xAI Grok Vision models
  'grok-4': true,
  'grok-4-fast': true,
  'grok-4-fast-reasoning': true,
  'grok-4-fast-non-reasoning': true,
  'grok-code-fast-1': true,
  'grok-2-vision': true,
  'grok-2-vision-latest': true,
  'grok-2-vision-1212': true,
  'grok-vision-beta': true,

  // Qwen3.5 Vision-Language Models
  'qwen3.5-397b-a17b': true,
  'qwen3.5-plus-2026-02-15': true,
  'qwen3.5-flash': true,
  'qwen3.5-122b-a10b': true,
  'qwen3.5-35b-a3b': true,
  'qwen3.5-27b': true,
  'qwen3-max-thinking': true,

  // Chinese/Asian Vision Models
  'glm-4.5v': true,

  // MiniMax Vision Models
  'MiniMax-M2.5': true,
  'minimax-m2.5': true,

  // Special handling for o1 models - they DON'T support vision
  'o1': false,
  'o1-mini': false,
  'o1-preview': false,
  'o3': false,
  'o3-mini': false,
  'o4-mini': false,
};

/** Strip provider prefix (e.g. "openai/gpt-5" -> "gpt-5") for map lookup */
const stripPrefix = (model: string): string => {
  const slashIdx = model.indexOf('/');
  return slashIdx >= 0 ? model.slice(slashIdx + 1) : model;
};

/**
 * Check if a model has vision/multimodal capabilities
 */
export function hasVisionCapability(model: string): boolean {
  // Try exact match first, then strip provider prefix
  if (model in VISION_CAPABLE_MODELS) {
    return VISION_CAPABLE_MODELS[model];
  }

  const bare = stripPrefix(model);
  if (bare !== model && bare in VISION_CAPABLE_MODELS) {
    return VISION_CAPABLE_MODELS[bare];
  }

  const lowerModel = bare.toLowerCase();

  if (lowerModel.includes('vision') || lowerModel.includes('-v-')) {
    return true;
  }

  if (lowerModel.includes('gpt-5')) {
    return true;
  }

  if (lowerModel.includes('gpt-4o') || lowerModel.includes('gpt-4.1')) {
    return true;
  }

  if (lowerModel.includes('claude-3') || lowerModel.includes('claude-4') ||
      lowerModel.includes('claude-opus-4') || lowerModel.includes('claude-sonnet-4') ||
      lowerModel.includes('claude-haiku-4')) {
    return true;
  }

  if (lowerModel.includes('gemini')) {
    return true;
  }

  if (lowerModel.includes('grok') && lowerModel.includes('vision')) {
    return true;
  }

  return false;
}

/**
 * Get a list of suggested vision-capable models for fallback
 */
export function getSuggestedVisionModels(): string[] {
  return [
    'gpt-4o-mini',
    'claude-3-haiku-20240307',
    'gemini-2.5-flash',
  ];
}
