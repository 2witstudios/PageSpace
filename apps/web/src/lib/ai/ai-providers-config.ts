/**
 * Centralized AI Provider Configuration
 * Single source of truth for all AI models across the application
 */

export const AI_PROVIDERS = {
  pagespace: {
    name: 'PageSpace',
    models: {
      'glm-4.5-air': 'Standard',
      'glm-4.6': 'Pro (Pro/Business)',
    },
  },
  openrouter: {
    name: 'OpenRouter (Paid)',
    models: {
      // Anthropic Models
      'anthropic/claude-3.5-sonnet': 'Claude 3.5 Sonnet',
      'anthropic/claude-3-haiku': 'Claude 3 Haiku',
      'anthropic/claude-opus-4.1': 'Claude Opus 4.1',
      
      // OpenAI Models
      'openai/gpt-4o': 'GPT-4o',
      'openai/gpt-4o-mini': 'GPT-4o Mini',
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
      
      // Chinese/Asian Models
      'z-ai/glm-4.5v': 'GLM 4.5V',
      'z-ai/glm-4.5': 'GLM 4.5',
      'z-ai/glm-4.5-air': 'GLM 4.5 Air',
      'z-ai/glm-4-32b': 'GLM 4 32B',
      'qwen/qwen3-235b-a22b-thinking-2507': 'Qwen3 235B Thinking',
      'qwen/qwen3-235b-a22b-2507': 'Qwen3 235B 2507',
      'qwen/qwen3-coder': 'Qwen3 Coder',
      'moonshotai/kimi-k2': 'Kimi K2',
      'minimax/minimax-m1': 'MiniMax M1',
      
      // Google Models (via OpenRouter)
      'google/gemini-2.5-pro': 'Gemini 2.5 Pro',
      'google/gemini-2.5-flash': 'Gemini 2.5 Flash',
      'google/gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
      'google/gemini-2.5-flash-lite-preview-06-17': 'Gemini 2.5 Flash Lite Preview',
      
      // AI21 Models
      'ai21/jamba-mini-1.7': 'Jamba Mini 1.7',
      'ai21/jamba-large-1.7': 'Jamba Large 1.7',
      
      // Other Models
      'x-ai/grok-4': 'Grok 4',
      'inception/mercury': 'Mercury',
    },
  },
  openrouter_free: {
    name: 'OpenRouter (Free)',
    models: {
      // Free Models - OpenAI
      'openai/gpt-oss-20b:free': 'GPT OSS 20B',
      
      // Free Models - Chinese/Asian
      'z-ai/glm-4.5-air:free': 'GLM 4.5 Air',
      'qwen/qwen3-coder:free': 'Qwen3 Coder',
      'qwen/qwen3-4b:free': 'Qwen3 4B',
      'qwen/qwen3-8b:free': 'Qwen3 8B',
      'qwen/qwen3-14b:free': 'Qwen3 14B',
      'qwen/qwen3-30b-a3b:free': 'Qwen3 30B A3B',
      'qwen/qwen3-235b-a22b:free': 'Qwen3 235B A22B',
      'moonshotai/kimi-k2:free': 'Kimi K2',
      'moonshotai/kimi-dev-72b:free': 'Kimi Dev 72B',
      'tencent/hunyuan-a13b-instruct:free': 'Hunyuan A13B',
      'sarvamai/sarvam-m:free': 'Sarvam M',
      
      // Free Models - DeepSeek
      'deepseek/deepseek-r1-0528:free': 'DeepSeek R1',
      'deepseek/deepseek-r1-0528-qwen3-8b:free': 'DeepSeek R1 Qwen3 8B',
      'tngtech/deepseek-r1t-chimera:free': 'DeepSeek R1T Chimera',
      'tngtech/deepseek-r1t2-chimera:free': 'DeepSeek R1T2 Chimera',
      
      // Free Models - Google
      'google/gemma-3n-e2b-it:free': 'Gemma 3N E2B',
      'google/gemma-3n-e4b-it:free': 'Gemma 3N E4B',
      
      // Free Models - Mistral
      'mistralai/mistral-small-3.2-24b-instruct:free': 'Mistral Small 3.2 24B',
      'mistralai/devstral-small-2505:free': 'Devstral Small',
      'cognitivecomputations/dolphin-mistral-24b-venice-edition:free': 'Dolphin Mistral 24B',
      
      // Free Models - Other
      'microsoft/mai-ds-r1:free': 'Microsoft MAI DS R1',
      'shisa-ai/shisa-v2-llama3.3-70b:free': 'Shisa v2 Llama 3.3 70B',
      'arliai/qwq-32b-arliai-rpr-v1:free': 'QwQ 32B ArliAI',
      'agentica-org/deepcoder-14b-preview:free': 'DeepCoder 14B',
    },
  },
  google: {
    name: 'Google AI',
    models: {
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
      'gemini-2.5-flash': 'Gemini 2.5 Flash',
      'gemini-2.5-flash-lite': 'Gemini 2.5 Flash-Lite',
      'gemini-2.0-flash-exp': 'Gemini 2.0 Flash',
      'gemini-1.5-pro': 'Gemini 1.5 Pro',
      'gemini-1.5-flash': 'Gemini 1.5 Flash',
    },
  },
  openai: {
    name: 'OpenAI',
    models: {
      // GPT-5 Models
      'gpt-5': 'GPT-5',
      'gpt-5-mini': 'GPT-5 Mini',
      'gpt-5-nano': 'GPT-5 Nano',
      
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
      'o3': 'O3',
      'o3-mini': 'O3 Mini',
      'o4-mini': 'O4 Mini',
      'o1': 'O1',
      'o1-mini': 'O1 Mini',
      'o1-preview': 'O1 Preview',
    },
  },
  anthropic: {
    name: 'Anthropic',
    models: {
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
      // Grok 4 Models
      'grok-4': 'Grok 4',

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
      'glm-4.6': 'GLM-4.6 (Standard)',
      'glm-4.5-air': 'GLM-4.5 Air (Fast)',
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