/**
 * Vision model capability detection.
 * This module is safe for client-side use — no server-only imports.
 * Server-side code should use model-capabilities.ts which re-exports these.
 *
 * Map entries follow OpenRouter's /api/v1/models `architecture.input_modalities`
 * ("image" → vision). Check a model there before adding or changing its entry.
 */
import { getBackendProvider } from './ai-providers-config';

const VISION_CAPABLE_MODELS: Record<string, boolean> = {
  // OpenAI GPT-6.2 / GPT-6.1 Terra Models
  'gpt-6.2-sol': true,
  'gpt-6.2-sol-pro': true,
  'gpt-6.2-astra': true,
  'gpt-6.2-astra-pro': true,
  'gpt-6.1-terra': true,
  'gpt-6.1-terra-pro': true,

  // OpenAI GPT-6 Models
  'gpt-6-luna': true,
  'gpt-6-luna-pro': true,
  'gpt-6-sol': true,
  'gpt-6-sol-pro': true,
  'gpt-6.1-sol': true,
  'gpt-6.1-sol-pro': true,
  'gpt-6-astra': true,
  'gpt-6-astra-pro': true,

  // OpenAI GPT-5.6 Models
  'gpt-5.6-sol-pro': true,
  'gpt-5.6-sol': true,
  'gpt-5.6-terra-pro': true,
  'gpt-5.6-terra': true,
  'gpt-5.6-luna-pro': true,
  'gpt-5.6-luna': true,

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
  // OpenRouter lists openai/gpt-4 as text-only.
  'gpt-4': false,
  'gpt-chat-latest': true,

  // Anthropic Claude 3+ (all have vision)
  'claude-haiku-5.5': true,
  'claude-fable-5.2': true,
  'claude-opus-5': true,
  'claude-opus-5-fast': true,
  'claude-sonnet-5': true,
  'claude-fable-5': true,
  'claude-opus-4.7': true,
  'claude-opus-4.7-fast-20260512': true,
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

  // Google Gemini 4 Series
  'gemini-4-neon': true,
  'gemini-4-hydrogen': true,
  'gemini-4-carbon': true,
  'gemini-4-argon': true,

  // Google Gemini (all versions support vision)
  'gemini-3.6-flash': true,
  'gemini-3.5-flash-lite': true,
  'gemini-3.1-flash-lite-image': true,
  'gemini-3.1-flash-image': true,
  'gemini-3-pro-image': true,
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

  // Google Gemini 3.5 Series
  'gemini-3.5-flash': true,

  // xAI Grok Vision models
  'grok-4.7': true,
  'grok-4.5': true,
  'grok-4.3': true,
  'grok-4.20': true,
  'grok-4.20-multi-agent': true,
  'grok-4': true,
  'grok-4-fast': true,
  'grok-4-fast-reasoning': true,
  'grok-4-fast-non-reasoning': true,
  'grok-code-fast-1': true,
  'grok-2-vision': true,
  'grok-2-vision-latest': true,
  'grok-2-vision-1212': true,
  'grok-vision-beta': true,

  // Qwen4 / Qwen3.5 Vision-Language Models
  'qwen4-max': true,
  'qwen3.8-omni-flash': true,
  'qwen3.7-plus': true,
  'qwen3.6-plus': true,
  'qwen3.6-flash': true,
  'qwen3.6-35b-a3b': true,
  'qwen3.6-27b': true,
  'qwen3.5-397b-a17b': true,
  'qwen3.5-plus-2026-02-15': true,
  'qwen3.5-flash': true,
  'qwen3.5-122b-a10b': true,
  'qwen3.5-35b-a3b': true,
  'qwen3.5-27b': true,
  'qwen3-max-thinking': true,

  // MiniMax Vision Models
  'minimax-m3.1-flash': true,
  'minimax-m3': true,
  // OpenRouter lists minimax-m2.5 as text-only.
  'MiniMax-M2.5': false,
  'minimax-m2.5': false,

  // Z.ai GLM: only the flash and "v" models take images. The bare ids double as
  // the admin-only Z.ai provider's model names.
  'glm-5.3-flash': true,
  'glm-5.3-flashx': true,
  'glm-5.3-flashx-legal': true,
  'glm-5v-turbo': true,
  'glm-4.6v': true,
  'glm-4.5v': true,
  'glm-5.3': false,
  'glm-5.3-prime': false,
  'glm-5.2': false,
  'glm-5.1': false,
  'glm-5': false,
  'glm-5-turbo': false,
  'glm-4.7': false,
  'glm-4.7-flash': false,
  'glm-4.6': false,
  'glm-4.5': false,
  'glm-4.5-air': false,

  // Qwen VL / omni models listed with image input on OpenRouter
  'qwen3-vl-235b-a22b-instruct': true,
  'qwen3-vl-30b-a3b-instruct': true,
  'qwen3-vl-8b-instruct': true,
  'qwen3.5-9b': true,
  'qwen3.5-flash-02-23': true,
  'qwen3.5-plus-02-15': true,
  'qwen3.5-plus-20260420': true,
  'qwen3.7-flash': true,
  'qwen3.8-27b': true,
  'qwen3.8-flash': true,
  'qwen3.8-max-0902': true,
  'qwen3.8-max-prime': true,

  // Gemma (Google open weights) with image input
  'gemma-3-12b-it': true,
  'gemma-3-27b-it': true,
  'gemma-4-26b-a4b-it': true,
  'gemma-4-26b-a4b-it:free': true,
  'gemma-4-31b-it': true,
  'gemma-4-31b-it:free': true,

  // Mistral models with image input
  'ministral-14b-2512': true,
  'ministral-3b-2512': true,
  'ministral-8b-2512': true,
  'mistral-large-2512': true,
  'mistral-medium-3-5': true,
  'mistral-small-2603': true,
  'mistral-small-3.2-24b-instruct': true,

  // Amazon Nova
  'nova-2-lite-v1': true,
  'nova-lite-v1': true,
  'nova-premier-v1': true,
  'nova-pro-v1': true,

  // Other multimodal OpenRouter models
  'kimi-k3.1-pro': true,
  'muse-wonder': true,
  'muse-spark-open': true,
  'muse-ember': true,
  'deepseek-v4.1-flash-1017': true,
  'mistral-large-4-0': true,
  'ling-3.2-flash:free': true,
  'nex-n2.6': true,
  'nex-n2.5-pro': true,
  'nemotron-3.5-super-vl': true,
  'nemotron-3.5-super-vl:free': true,
  'fugu-ultra-v2': true,
  'fugu-max': true,
  'step-5-preview': true,
  'hy4': true,
  'hy4-flash': true,
  'inkling-2-small': true,
  'inkling-2-mini': true,
  'kimi-k3': true,
  'kimi-k2.7-code': true,
  'kimi-k2.6': true,
  'muse-spark-1.3': true,
  'muse-spark-1.3-contributor': true,
  'muse-spark-1.1': true,
  'llama-4-maverick': true,
  'llama-4-scout': true,
  'seed-2.0-lite': true,
  'seed-2.0-mini': true,
  'seed-2-1-turbo': true,
  'command-a-plus': true,
  'deepseek-v4.1-flash': true,
  'muse-glimmer-30b': true,
  'muse-spark-1.2': true,
  'muse-spark-1.2-contributor': true,
  'kimi-k2.5': true,
  'nemotron-3-nano-omni-30b-a3b-reasoning:free': true,
  'reka-edge': true,
  'fugu-ultra': true,
  'sakana-namazu': true,
  'step-3.7-flash': true,
  'inkling': true,
  'inkling-small': true,
  'grok-4.6': true,
  'mimo-v2.6-flash': true,
  'mimo-v2.6-pro': true,

  // Special handling for o1 models - they DON'T support vision
  'o1': false,
  'o1-mini': false,
  'o1-preview': false,
  // OpenRouter lists o3 and o3-pro with image and file input.
  'o3': true,
  'o3-pro': true,
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

  // "-v-", a version-v suffix ("glm-4.6v", "glm-5v-turbo") or "v-turbo" all name
  // vision variants. The digit must come right before the "v": "deepseek-v4" is a
  // version prefix, not a vision model.
  if (lowerModel.includes('vision') || lowerModel.includes('-v-') ||
      /\d+(\.\d+)?v\b/.test(lowerModel) || lowerModel.includes('v-turbo')) {
    return true;
  }

  if (lowerModel.includes('gpt-5')) {
    return true;
  }

  if (lowerModel.includes('gpt-4o') || lowerModel.includes('gpt-4.1')) {
    return true;
  }

  if (lowerModel.includes('claude-3') || lowerModel.includes('claude-4') ||
      lowerModel.includes('claude-5') ||
      lowerModel.includes('claude-opus-4') || lowerModel.includes('claude-sonnet-4') ||
      lowerModel.includes('claude-haiku-4') ||
      /claude-(opus|sonnet|haiku|fable)-\d/.test(lowerModel)) {
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
 * Whether a model reads a PDF natively when read_page hands it one as a `file-data`
 * part (`application/pdf`). The OpenRouter provider maps that part to OpenRouter's
 * `file` content, so only OpenRouter-backed providers qualify. The families here
 * are the ones OpenRouter lists with "file" input: Gemini, Claude and GPT-4o/4.1/5/6.
 * Every one of them also has vision, which is checked too so the two labels
 * cannot disagree. Codex and image-generation variants are listed without file
 * input, so they are left out.
 */
export function hasPdfInputCapability(model: string, provider: string): boolean {
  if (getBackendProvider(provider) !== 'openrouter') return false;
  if (!hasVisionCapability(model)) return false;
  const bare = stripPrefix(model).toLowerCase();
  if (bare.includes('-codex') || /-image(\b|-)/.test(bare)) return false;
  return bare.startsWith('gemini-') ||
    bare.startsWith('claude-') ||
    /^gpt-(4o|4\.1|5|6)/.test(bare);
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
