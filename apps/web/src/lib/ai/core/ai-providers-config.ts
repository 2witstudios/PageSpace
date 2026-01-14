/**
 * Centralized AI Provider Configuration
 * Single source of truth for all AI models across the application
 */

export const AI_PROVIDERS = {
  pagespace: {
    name: 'PageSpace',
    models: {
      'glm-4.5-air': 'Standard',
      'glm-4.7': 'Pro (Pro/Business)',
    },
  },
  openrouter: {
    name: 'OpenRouter (Paid)',
    models: {
      // Anthropic Models (2025)
      'anthropic/claude-opus-4.5': 'Claude Opus 4.5',
      'anthropic/claude-sonnet-4.5': 'Claude Sonnet 4.5',
      'anthropic/claude-haiku-4.5': 'Claude Haiku 4.5',
      'anthropic/claude-3.5-sonnet': 'Claude 3.5 Sonnet',
      'anthropic/claude-3-haiku': 'Claude 3 Haiku',

      // OpenAI Models (2025)
      'openai/gpt-5.2': 'GPT-5.2',
      'openai/gpt-5.2-codex': 'GPT-5.2 Codex',
      'openai/gpt-5.2-mini': 'GPT-5.2 Mini',
      'openai/gpt-5.2-nano': 'GPT-5.2 Nano',
      'openai/gpt-5.1': 'GPT-5.1',
      'openai/gpt-5.1-codex': 'GPT-5.1 Codex',
      'openai/gpt-5.1-codex-mini': 'GPT-5.1 Codex Mini',
      'openai/gpt-4o': 'GPT-4o',
      'openai/gpt-4o-mini': 'GPT-4o Mini',
      'openai/o3-deep-research': 'o3 Deep Research',
      'openai/o4-mini-deep-research': 'o4 Mini Deep Research',
      'openai/gpt-5': 'GPT-5',
      'openai/gpt-5-mini': 'GPT-5 Mini',
      'openai/gpt-5-nano': 'GPT-5 Nano',
      'openai/gpt-oss-120b': 'GPT OSS 120B',
      'openai/gpt-oss-20b': 'GPT OSS 20B',

      // Meta Models
      'meta-llama/llama-3.1-405b-instruct': 'Llama 3.1 405B',

      // Mistral Models
      'mistralai/mistral-medium-3.1': 'Mistral Medium 3.1',
      'mistralai/mistral-small-3.2-24b-instruct': 'Mistral Small 3.2 24B',
      'mistralai/codestral-2508': 'Codestral 2508',
      'mistralai/devstral-medium': 'Devstral Medium',
      'mistralai/devstral-small': 'Devstral Small',

      // Chinese/Asian Models (2025)
      'z-ai/glm-4.7': 'GLM 4.7',
      'z-ai/glm-4.5v': 'GLM 4.5V',
      'z-ai/glm-4.5': 'GLM 4.5',
      'z-ai/glm-4.5-air': 'GLM 4.5 Air',
      'z-ai/glm-4-32b': 'GLM 4 32B',
      'qwen/qwen3-max': 'Qwen3 Max',
      'qwen/qwen3-235b-a22b-thinking-2507': 'Qwen3 235B Thinking',
      'qwen/qwen3-235b-a22b-2507': 'Qwen3 235B 2507',
      'qwen/qwen3-coder': 'Qwen3 Coder',
      'moonshotai/kimi-k2': 'Kimi K2',
      'minimax/minimax-m1': 'MiniMax M1',

      // DeepSeek Models (2025)
      'deepseek/deepseek-v3.1-terminus': 'DeepSeek V3.1 Terminus',

      // Google Models (via OpenRouter)
      'google/gemini-3-pro-preview': 'Gemini 3 Pro',
      'google/gemini-3-flash-preview': 'Gemini 3 Flash (Preview)',
      'google/gemini-2.5-pro': 'Gemini 2.5 Pro',
      'google/gemini-2.5-flash': 'Gemini 2.5 Flash',
      'google/gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
      'google/gemini-2.5-flash-lite-preview-06-17': 'Gemini 2.5 Flash Lite Preview',
      'google/gemini-2.0-pro': 'Gemini 2.0 Pro',

      // AI21 Models
      'ai21/jamba-mini-1.7': 'Jamba Mini 1.7',
      'ai21/jamba-large-1.7': 'Jamba Large 1.7',

      // xAI Models (2025)
      'x-ai/grok-4-fast': 'Grok 4 Fast (2M context)',
      'x-ai/grok-4': 'Grok 4',

      // Other Models
      'inception/mercury': 'Mercury',
    },
  },
  openrouter_free: {
    name: 'OpenRouter (Free)',
    models: {
      // Coding Models
      'qwen/qwen3-coder:free': 'Qwen3 Coder',
      'kwaipilot/kat-coder-pro:free': 'Kat Coder Pro',
      'mistralai/devstral-small-2505:free': 'Devstral Small',
      'mistralai/devstral-2512:free': 'Devstral 2512',

      // Large Models (405B+)
      'meta-llama/llama-3.1-405b-instruct:free': 'Llama 3.1 405B',
      'nousresearch/hermes-3-llama-3.1-405b:free': 'Hermes 3 405B',

      // Reasoning Models
      'deepseek/deepseek-r1-0528:free': 'DeepSeek R1',
      'tngtech/deepseek-r1t-chimera:free': 'DeepSeek R1T Chimera',
      'tngtech/tng-r1t-chimera:free': 'TNG R1T Chimera',
      'nex-agi/deepseek-v3.1-nex-n1:free': 'DeepSeek V3.1 Nex N1',
      'allenai/olmo-3.1-32b-think:free': 'OLMo 3.1 32B Think',
      'allenai/olmo-3-32b-think:free': 'OLMo 3 32B Think',

      // Google Models
      'google/gemini-2.0-flash-exp:free': 'Gemini 2.0 Flash',
      'google/gemma-3-27b-it:free': 'Gemma 3 27B',
      'google/gemma-3-12b-it:free': 'Gemma 3 12B',
      'google/gemma-3-4b-it:free': 'Gemma 3 4B',

      // Meta Llama Models
      'meta-llama/llama-3.3-70b-instruct:free': 'Llama 3.3 70B',
      'meta-llama/llama-3.2-3b-instruct:free': 'Llama 3.2 3B',

      // Mistral Models
      'mistralai/mistral-small-3.1-24b-instruct:free': 'Mistral Small 3.1 24B',
      'mistralai/mistral-7b-instruct:free': 'Mistral 7B',
      'cognitivecomputations/dolphin-mistral-24b-venice-edition:free': 'Dolphin Mistral 24B',

      // Chinese/Asian Models
      'z-ai/glm-4.5-air:free': 'GLM 4.5 Air',
      'qwen/qwen3-4b:free': 'Qwen3 4B',
      'qwen/qwen-2.5-vl-7b-instruct:free': 'Qwen 2.5 VL 7B',
      'moonshotai/kimi-k2:free': 'Kimi K2',
      'alibaba/tongyi-deepresearch-30b-a3b:free': 'Tongyi DeepResearch 30B',
      'xiaomi/mimo-v2-flash:free': 'MiMo V2 Flash',

      // OpenAI OSS Models
      'openai/gpt-oss-120b:free': 'GPT OSS 120B',
      'openai/gpt-oss-20b:free': 'GPT OSS 20B',

      // Other Models
      'nvidia/nemotron-nano-12b-v2-vl:free': 'Nemotron Nano 12B VL',
      'nvidia/nemotron-3-nano-30b-a3b:free': 'Nemotron 3 Nano 30B',
      'arcee-ai/trinity-mini:free': 'Trinity Mini',
    },
  },
  google: {
    name: 'Google AI',
    models: {
      // Gemini 3 Series (2025)
      'gemini-3-pro': 'Gemini 3 Pro',
      'gemini-3-flash-preview': 'Gemini 3 Flash (Preview)',
      // Gemini 2.5 Series (2025)
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
      'gemini-2.5-flash': 'Gemini 2.5 Flash',
      'gemini-2.5-flash-lite': 'Gemini 2.5 Flash-Lite',
      // Gemini 2.0 Series (2025)
      'gemini-2.0-pro-exp': 'Gemini 2.0 Pro (Experimental)',
      'gemini-2.0-flash': 'Gemini 2.0 Flash',
      'gemini-2.0-flash-exp': 'Gemini 2.0 Flash (Experimental)',
      'gemini-2.0-flash-lite': 'Gemini 2.0 Flash-Lite',
      // Gemini 1.5 Series
      'gemini-1.5-pro': 'Gemini 1.5 Pro',
      'gemini-1.5-flash': 'Gemini 1.5 Flash',
      'gemini-1.5-flash-8b': 'Gemini 1.5 Flash 8B',
    },
  },
  openai: {
    name: 'OpenAI',
    models: {
      // GPT-5.2 Models (2025)
      'gpt-5.2': 'GPT-5.2',
      'gpt-5.2-codex': 'GPT-5.2 Codex',
      'gpt-5.2-mini': 'GPT-5.2 Mini',
      'gpt-5.2-nano': 'GPT-5.2 Nano',

      // GPT-5.1 Models (2025)
      'gpt-5.1': 'GPT-5.1',
      'gpt-5.1-codex': 'GPT-5.1 Codex',

      // GPT-5 Models (2025)
      'gpt-5': 'GPT-5',
      'gpt-5-mini': 'GPT-5 Mini',
      'gpt-5-nano': 'GPT-5 Nano',

      // GPT-4.1 Models (2025)
      'gpt-4.1-2025-04-14': 'GPT-4.1',
      'gpt-4.1-mini-2025-04-14': 'GPT-4.1 Mini',
      'gpt-4.1-nano-2025-04-14': 'GPT-4.1 Nano',

      // GPT-4o Models
      'gpt-4o': 'GPT-4o',
      'gpt-4o-mini': 'GPT-4o Mini',
      'gpt-4o-audio-preview': 'GPT-4o Audio Preview',

      // GPT-4 Models
      'gpt-4-turbo': 'GPT-4 Turbo',
      'gpt-4': 'GPT-4',

      // GPT-3.5 Models
      'gpt-3.5-turbo': 'GPT-3.5 Turbo',

      // Reasoning Models
      'o4-mini-2025-04-16': 'O4 Mini',
      'o3': 'O3',
      'o3-mini': 'O3 Mini',
      'o1': 'O1',
      'o1-mini': 'O1 Mini',
      'o1-preview': 'O1 Preview',
    },
  },
  anthropic: {
    name: 'Anthropic',
    models: {
      // Claude 4.5 Models (2025)
      'claude-opus-4-5-20251124': 'Claude Opus 4.5',
      'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
      'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',

      // Claude 4.1 Models
      'claude-opus-4-1-20250805': 'Claude Opus 4.1',
      'claude-sonnet-4-1-20250805': 'Claude Sonnet 4.1',

      // Claude 3.7 Models
      'claude-3-7-sonnet-20250219': 'Claude 3.7 Sonnet',

      // Claude 3.5 Models
      'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet',
      'claude-3-5-sonnet-20240620': 'Claude 3.5 Sonnet (June)',
      'claude-3-5-haiku-20241022': 'Claude 3.5 Haiku',

      // Claude 3 Models
      'claude-3-opus-20240229': 'Claude 3 Opus',
      'claude-3-sonnet-20240229': 'Claude 3 Sonnet',
      'claude-3-haiku-20240307': 'Claude 3 Haiku',
    },
  },
  xai: {
    name: 'xAI (Grok)',
    models: {
      // Grok 4 Models (2025)
      'grok-4': 'Grok 4',
      'grok-4-fast-reasoning': 'Grok 4 Fast (Reasoning)',
      'grok-4-fast-non-reasoning': 'Grok 4 Fast (Non-Reasoning)',
      'grok-code-fast-1': 'Grok Code Fast 1',

      // Grok 3 Models
      'grok-3': 'Grok 3',
      'grok-3-latest': 'Grok 3 Latest',
      'grok-3-fast': 'Grok 3 Fast',
      'grok-3-fast-latest': 'Grok 3 Fast Latest',
      'grok-3-mini': 'Grok 3 Mini',
      'grok-3-mini-latest': 'Grok 3 Mini Latest',
      'grok-3-mini-fast': 'Grok 3 Mini Fast',
      'grok-3-mini-fast-latest': 'Grok 3 Mini Fast Latest',

      // Grok 2 Models
      'grok-2': 'Grok 2',
      'grok-2-latest': 'Grok 2 Latest',
      'grok-2-1212': 'Grok 2 (December)',
      'grok-2-vision': 'Grok 2 Vision',
      'grok-2-vision-latest': 'Grok 2 Vision Latest',
      'grok-2-vision-1212': 'Grok 2 Vision (December)',

      // Beta Models
      'grok-beta': 'Grok Beta',
      'grok-vision-beta': 'Grok Vision Beta',
    },
  },
  ollama: {
    name: 'Ollama (Local)',
    models: {
      // Note: Model list will be discovered dynamically from local Ollama instance
      // No fallback models - requires Ollama server to be running
    },
  },
  lmstudio: {
    name: 'LM Studio (Local)',
    models: {
      // Note: Model list will be discovered dynamically from running LM Studio instance
      // No fallback models - requires LM Studio server to be running
    },
  },
  glm: {
    name: 'GLM Coder Plan',
    models: {
      'glm-4.7': 'GLM-4.7 (Standard)',
      'glm-4.6': 'GLM-4.6',
      'glm-4.5-air': 'GLM-4.5 Air (Fast)',
    },
  },
  minimax: {
    name: 'MiniMax',
    models: {
      'MiniMax-M2.1': 'MiniMax M2.1',
      'MiniMax-M2': 'MiniMax M2',
      'MiniMax-M2-Stable': 'MiniMax M2 Stable',
    },
  },
} as const;

/**
 * Map UI provider to backend provider
 * Both openrouter and openrouter_free use 'openrouter' backend
 * PageSpace uses 'glm' backend (OpenAI-compatible endpoints)
 * GLM uses 'openai' backend (OpenAI-compatible endpoints)
 * OpenAI, Anthropic, and xAI use their own backends
 */
export function getBackendProvider(uiProvider: string): string {
  if (uiProvider === 'pagespace') {
    return 'glm';
  }
  if (uiProvider === 'openrouter_free') {
    return 'openrouter';
  }
  if (uiProvider === 'glm') {
    return 'openai';
  }
  return uiProvider;
}

/**
 * Get default model for a provider
 */
export function getDefaultModel(provider: string): string {
  // Always return glm-4.5-air for PageSpace provider
  if (provider === 'pagespace') {
    return 'glm-4.5-air';
  }

  // Always return gemini-2.5-flash for Google provider
  if (provider === 'google') {
    return 'gemini-2.5-flash';
  }

  const providerConfig = AI_PROVIDERS[provider as keyof typeof AI_PROVIDERS];
  if (!providerConfig) {
    return 'glm-4.5-air'; // fallback default to GLM 4.5 Air
  }

  return Object.keys(providerConfig.models)[0];
}

/**
 * Check if a model is valid for a provider
 */
export function isValidModel(provider: string, model: string): boolean {
  const providerConfig = AI_PROVIDERS[provider as keyof typeof AI_PROVIDERS];
  if (!providerConfig) return false;
  return model in providerConfig.models;
}

/**
 * Get display name for a model
 */
export function getModelDisplayName(provider: string, model: string): string {
  const providerConfig = AI_PROVIDERS[provider as keyof typeof AI_PROVIDERS];
  if (!providerConfig) return model;
  return providerConfig.models[model as keyof typeof providerConfig.models] || model;
}

export type AIProvider = keyof typeof AI_PROVIDERS;
export type AIModel<T extends AIProvider> = keyof typeof AI_PROVIDERS[T]['models'];

/**
 * Get user-facing display name for AI usage.
 * Hides underlying model details from users for privacy/branding.
 *
 * For PageSpace provider: Shows "PageSpace Standard" or "PageSpace Pro"
 * For all other providers: Shows "PageSpace AI" to abstract away the underlying model
 *
 * @param provider - The AI provider (e.g., 'pagespace', 'openrouter', 'google')
 * @param model - The model identifier (e.g., 'glm-4.5-air', 'glm-4.7')
 * @returns User-friendly display name
 */
export function getUserFacingModelName(provider: string | null | undefined, model: string | null | undefined): string {
  // Default fallback
  if (!model) {
    return 'PageSpace AI';
  }

  // For PageSpace provider, show tier-based naming
  if (provider === 'pagespace') {
    if (model === 'glm-4.7') {
      return 'PageSpace Pro';
    }
    if (model === 'glm-4.5-air') {
      return 'PageSpace Standard';
    }
    // Any other PageSpace model defaults to Standard
    return 'PageSpace Standard';
  }

  // For all other providers, abstract away the model details
  // Users shouldn't see the underlying model names (GLM, Claude, GPT, etc.)
  return 'PageSpace AI';
}