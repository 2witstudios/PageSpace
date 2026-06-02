/**
 * Centralized AI Provider Configuration
 * Single source of truth for all AI models across the application
 */

/**
 * PageSpace Model Aliases
 * Allows agents to use friendly names (standard/pro) instead of underlying model IDs.
 * This abstraction lets agents update their model without knowing the specific backend model.
 */
export const PAGESPACE_MODEL_ALIASES: Record<string, string> = {
  standard: 'glm-4.7',
  pro: 'glm-5',
} as const;

/**
 * Resolve a PageSpace model alias to the actual model ID
 * @param modelOrAlias - Either an alias ('standard', 'pro') or actual model ID
 * @returns The resolved model ID
 */
export function resolvePageSpaceModel(modelOrAlias: string): string {
  const lowercased = modelOrAlias.toLowerCase();
  return PAGESPACE_MODEL_ALIASES[lowercased] || modelOrAlias;
}

/**
 * Check if a string is a PageSpace model alias
 */
export function isPageSpaceModelAlias(model: string): boolean {
  return model.toLowerCase() in PAGESPACE_MODEL_ALIASES;
}

/**
 * Get the PageSpace tier ('standard' or 'pro') for a given model
 * Returns null if the model is not a PageSpace tier model
 *
 * This is the reverse lookup of PAGESPACE_MODEL_ALIASES - given a model ID,
 * find which tier it belongs to. Used for rate limiting and subscription checks.
 */
export function getPageSpaceModelTier(model: string): 'standard' | 'pro' | null {
  const modelLower = model.toLowerCase();
  for (const [tier, tierModel] of Object.entries(PAGESPACE_MODEL_ALIASES)) {
    if (tierModel.toLowerCase() === modelLower) {
      return tier as 'standard' | 'pro';
    }
  }
  return null;
}

/**
 * Classify a (provider, model) pair into the daily-quota tier the call should
 * count against. Used by the rate-limit gate and subscription check so all
 * managed providers share the same per-tier quota.
 *
 * Pro tier covers frontier flagship models (Claude Opus, GPT-5, OpenAI o3,
 * GLM 5). Smaller variants (mini/nano/flash/haiku/lite/small) are always
 * demoted to standard regardless of family.
 */
export function getProviderTier(provider: string, model: string | undefined): 'standard' | 'pro' {
  if (provider === 'pagespace' && model) {
    return getPageSpaceModelTier(resolvePageSpaceModel(model)) === 'pro' ? 'pro' : 'standard';
  }
  if (!model) return 'standard';

  const m = model.toLowerCase();

  if (/\b(mini|nano|flash|haiku|lite|small)\b/.test(m)) return 'standard';
  if (m.includes('opus')) return 'pro';
  if (/\bgpt-?5(\.|-|$|\/)/.test(m)) return 'pro';
  if (/\bo3([\s-]|$|\/)/.test(m)) return 'pro';
  if (m === 'glm-5' || m.endsWith('/glm-5')) return 'pro';

  return 'standard';
}

export const AI_PROVIDERS = {
  pagespace: {
    name: 'PageSpace',
    models: {
      'glm-4.7': 'Standard',
      'glm-5': 'Pro (Pro/Business)',
    },
  },
  openrouter: {
    name: 'OpenRouter (Paid)',
    models: {
      // Anthropic Models (2026)
      'anthropic/claude-opus-4.8': 'Claude Opus 4.8',
      'anthropic/claude-opus-4.8-fast': 'Claude Opus 4.8 Fast',
      'anthropic/claude-opus-4.7': 'Claude Opus 4.7',
      'anthropic/claude-opus-4.7-fast': 'Claude Opus 4.7 Fast',
      'anthropic/claude-opus-4.6': 'Claude Opus 4.6',
      'anthropic/claude-opus-4.6-fast': 'Claude Opus 4.6 Fast',
      'anthropic/claude-sonnet-4.6': 'Claude Sonnet 4.6',

      // Anthropic Models (2025)
      'anthropic/claude-opus-4.1': 'Claude Opus 4.1',
      'anthropic/claude-opus-4': 'Claude Opus 4',
      'anthropic/claude-sonnet-4': 'Claude Sonnet 4',
      'anthropic/claude-opus-4.5': 'Claude Opus 4.5',
      'anthropic/claude-sonnet-4.5': 'Claude Sonnet 4.5',
      'anthropic/claude-haiku-4.5': 'Claude Haiku 4.5',
      'anthropic/claude-3.5-haiku': 'Claude 3.5 Haiku',
      'anthropic/claude-3-haiku': 'Claude 3 Haiku',

      // OpenAI Models (2026)
      'openai/gpt-5.5-pro': 'GPT-5.5 Pro',
      'openai/gpt-5.5': 'GPT-5.5',
      'openai/gpt-5.4-pro': 'GPT-5.4 Pro',
      'openai/gpt-5.4': 'GPT-5.4',
      'openai/gpt-5.4-mini': 'GPT-5.4 Mini',
      'openai/gpt-5.4-nano': 'GPT-5.4 Nano',
      'openai/gpt-5.3-chat': 'GPT-5.3 Chat',
      'openai/gpt-5.3-codex': 'GPT-5.3 Codex',

      'openai/gpt-5.2-pro': 'GPT-5.2 Pro',
      'openai/gpt-5.2-chat': 'GPT-5.2 Chat',
      // OpenAI Models (2025)
      'openai/gpt-5.2': 'GPT-5.2',
      'openai/gpt-5.2-codex': 'GPT-5.2 Codex',
      'openai/gpt-5.1': 'GPT-5.1',
      'openai/gpt-5.1-chat': 'GPT-5.1 Chat',
      'openai/gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
      'openai/gpt-5.1-codex': 'GPT-5.1 Codex',
      'openai/gpt-5.1-codex-mini': 'GPT-5.1 Codex Mini',
      'openai/gpt-4o': 'GPT-4o',
      'openai/gpt-4o-mini': 'GPT-4o Mini',
      'openai/gpt-4.1': 'GPT-4.1',
      'openai/gpt-4.1-mini': 'GPT-4.1 Mini',
      'openai/o3': 'o3',
      'openai/o3-pro': 'o3 Pro',
      'openai/o4-mini': 'o4 Mini',
      'openai/o3-deep-research': 'o3 Deep Research',
      'openai/o4-mini-deep-research': 'o4 Mini Deep Research',
      'openai/gpt-5-pro': 'GPT-5 Pro',
      'openai/gpt-5-codex': 'GPT-5 Codex',
      'openai/gpt-5': 'GPT-5',
      'openai/gpt-5-mini': 'GPT-5 Mini',
      'openai/gpt-5-nano': 'GPT-5 Nano',
      'openai/gpt-oss-120b': 'GPT OSS 120B',
      'openai/gpt-oss-20b': 'GPT OSS 20B',

      // Google Models (via OpenRouter)
      'google/gemini-3.5-flash': 'Gemini 3.5 Flash',
      'google/gemini-3.1-pro-preview': 'Gemini 3.1 Pro (Preview)',
      'google/gemini-3.1-pro-preview-customtools': 'Gemini 3.1 Pro Custom Tools (Preview)',
      'google/gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
      'google/gemini-3.1-flash-lite-preview': 'Gemini 3.1 Flash Lite (Preview)',
      'google/gemini-3.1-flash-image-preview': 'Gemini 3.1 Flash Image',
      'google/gemini-3-flash-preview': 'Gemini 3 Flash (Preview)',
      'google/gemini-2.5-pro': 'Gemini 2.5 Pro',
      'google/gemini-2.5-flash': 'Gemini 2.5 Flash',
      'google/gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
      'google/gemma-4-31b-it': 'Gemma 4 31B',
      'google/gemma-4-26b-a4b-it': 'Gemma 4 26B A4B',

      // Meta Models
      'meta-llama/llama-4-maverick': 'Llama 4 Maverick',
      'meta-llama/llama-4-scout': 'Llama 4 Scout',
      'meta-llama/llama-3.3-70b-instruct': 'Llama 3.3 70B',

      // Mistral Models (source: openrouter.ai/api/v1/models)
      'mistralai/mistral-large-2512': 'Mistral Large 3',
      'mistralai/mistral-medium-3-5': 'Mistral Medium 3.5',
      'mistralai/mistral-small-2603': 'Mistral Small (2603)',
      'mistralai/mistral-medium-3.1': 'Mistral Medium 3.1',
      'mistralai/mistral-medium-3': 'Mistral Medium 3',
      'mistralai/mistral-small-3.2-24b-instruct': 'Mistral Small 3.2 24B',
      'mistralai/codestral-2508': 'Codestral 2508',
      'mistralai/devstral-2512': 'Devstral 2',

      // Chinese/Asian Models (2025-2026)
      'z-ai/glm-5.1': 'GLM 5.1',
      'z-ai/glm-5-turbo': 'GLM 5 Turbo',
      'z-ai/glm-5': 'GLM 5',
      'z-ai/glm-4.7-flash': 'GLM 4.7 Flash',
      'z-ai/glm-4.7': 'GLM 4.7',
      'z-ai/glm-4.6': 'GLM 4.6',
      'z-ai/glm-4.5v': 'GLM 4.5V',
      'z-ai/glm-4.5': 'GLM 4.5',
      'z-ai/glm-4.5-air': 'GLM 4.5 Air',
      'z-ai/glm-4-32b': 'GLM 4 32B',
      'qwen/qwen3.7-max': 'Qwen3.7 Max',
      'qwen/qwen3.6-max-preview': 'Qwen3.6 Max (Preview)',
      'qwen/qwen3.6-plus': 'Qwen3.6 Plus',
      'qwen/qwen3.6-flash': 'Qwen3.6 Flash',
      'qwen/qwen3.6-35b-a3b': 'Qwen3.6 35B-A3B',
      'qwen/qwen3.6-27b': 'Qwen3.6 27B',
      'qwen/qwen3.5-plus-20260420': 'Qwen3.5 Plus',
      'qwen/qwen3.5-flash-02-23': 'Qwen3.5 Flash',
      'qwen/qwen3.5-397b-a17b': 'Qwen3.5 397B-A17B',
      'qwen/qwen3.5-122b-a10b': 'Qwen3.5 122B-A10B',
      'qwen/qwen3.5-35b-a3b': 'Qwen3.5 35B-A3B',
      'qwen/qwen3.5-27b': 'Qwen3.5 27B',
      'qwen/qwen3-max-thinking': 'Qwen3 Max Thinking',
      'qwen/qwen3-max': 'Qwen3 Max',
      'qwen/qwen3-235b-a22b-thinking-2507': 'Qwen3 235B Thinking',
      'qwen/qwen3-235b-a22b-2507': 'Qwen3 235B 2507',
      'qwen/qwen3-coder': 'Qwen3 Coder',
      'moonshotai/kimi-k2.6': 'Kimi K2.6',
      'moonshotai/kimi-k2-thinking': 'Kimi K2 Thinking',
      'moonshotai/kimi-k2': 'Kimi K2',
      'minimax/minimax-m3': 'MiniMax M3',
      'minimax/minimax-m2.7': 'MiniMax M2.7',
      'minimax/minimax-m2.5': 'MiniMax M2.5',
      'minimax/minimax-m2.1': 'MiniMax M2.1',
      'minimax/minimax-m1': 'MiniMax M1',
      'bytedance-seed/seed-2.0-lite': 'Seed 2.0 Lite',
      'bytedance-seed/seed-2.0-mini': 'Seed 2.0 Mini',

      // DeepSeek Models (2025-2026)
      'deepseek/deepseek-v4-pro': 'DeepSeek V4 Pro',
      'deepseek/deepseek-v4-flash': 'DeepSeek V4 Flash',
      'deepseek/deepseek-v3.2': 'DeepSeek V3.2',
      'deepseek/deepseek-v3.1-terminus': 'DeepSeek V3.1 Terminus',
      'deepseek/deepseek-r1-0528': 'DeepSeek R1',

      // xAI Models (source: docs.x.ai/docs/models)
      'x-ai/grok-4.3': 'Grok 4.3',
      'x-ai/grok-4.20': 'Grok 4.20',
      'x-ai/grok-4.20-multi-agent': 'Grok 4.20 Multi-Agent',
      'x-ai/grok-build-0.1': 'Grok Build 0.1',

      // AI21 Models
      'ai21/jamba-large-1.7': 'Jamba Large 1.7',

      // Other Models
      'inception/mercury-2': 'Mercury 2',
      'writer/palmyra-x5': 'Palmyra X5',
    },
  },
  openrouter_free: {
    name: 'OpenRouter (Free)',
    models: {},
  },
  google: {
    name: 'Google AI',
    models: {
      // Gemini 3.5 Series (2026)
      'gemini-3.5-flash': 'Gemini 3.5 Flash',
      // Gemini 3 Series (2025)
      'gemini-3.1-pro-preview': 'Gemini 3.1 Pro (Preview)',
      'gemini-3.1-pro-preview-customtools': 'Gemini 3.1 Pro Custom Tools (Preview)',
      'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite',
      'gemini-3.1-flash-lite-preview': 'Gemini 3.1 Flash Lite (Preview)',
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
      // GPT-5.4 Models (2026)
      'gpt-5.4-pro': 'GPT-5.4 Pro',
      'gpt-5.4': 'GPT-5.4',

      // GPT-5.3 Models (2026)
      'gpt-5.3-chat-latest': 'GPT-5.3 Chat',
      'gpt-5.3-codex': 'GPT-5.3 Codex',

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
      // Claude 4.7 Models — current (source: platform.claude.com/docs/about-claude/models)
      'claude-opus-4-7': 'Claude Opus 4.7',

      // Claude 4.6 Models
      'claude-opus-4-6': 'Claude Opus 4.6',
      'claude-sonnet-4-6': 'Claude Sonnet 4.6',

      // Claude 4.5 Models
      'claude-opus-4-5-20251101': 'Claude Opus 4.5',
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
  azure_openai: {
    name: 'Azure OpenAI',
    models: {
      // Model list depends on the user's Azure deployment - discovered dynamically
      // Users configure their deployment name as the model ID
    },
  },
  glm: {
    name: 'GLM Coder Plan',
    models: {
      'glm-5': 'GLM-5 (Pro)',
      'glm-4.7': 'GLM-4.7 (Standard)',
      'glm-4.6': 'GLM-4.6',
      'glm-4.5-air': 'GLM-4.5 Air (Fast)',
    },
  },
  minimax: {
    name: 'MiniMax',
    models: {
      'MiniMax-M2.5': 'MiniMax M2.5',
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
  // Always return glm-4.7 for PageSpace provider (Standard tier)
  if (provider === 'pagespace') {
    return 'glm-4.7';
  }

  // Always return gemini-3.5-flash for Google provider
  if (provider === 'google') {
    return 'gemini-3.5-flash';
  }

  const providerConfig = AI_PROVIDERS[provider as keyof typeof AI_PROVIDERS];
  if (!providerConfig) {
    return 'glm-4.7';
  }

  const models = Object.keys(providerConfig.models);
  return models[0] ?? '';
}

/**
 * Check if a model is valid for a provider
 */
export function isValidModel(provider: string, model: string): boolean {
  const providerConfig = AI_PROVIDERS[provider as keyof typeof AI_PROVIDERS];
  if (!providerConfig) return false;
  // For PageSpace, also accept aliases (standard, pro)
  if (provider === 'pagespace' && isPageSpaceModelAlias(model)) {
    return true;
  }
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
 * @param model - The model identifier (e.g., 'glm-4.5-air', 'glm-4.7', 'standard', 'pro')
 * @returns User-friendly display name
 */
export function getUserFacingModelName(provider: string | null | undefined, model: string | null | undefined): string {
  // Default fallback
  if (!model) {
    return 'PageSpace AI';
  }

  // For PageSpace provider, show tier-based naming
  if (provider === 'pagespace') {
    const resolvedModel = resolvePageSpaceModel(model);
    const tier = getPageSpaceModelTier(resolvedModel);
    if (tier === 'pro') return 'PageSpace Pro';
    return 'PageSpace Standard';
  }

  // For all other providers, abstract away the model details
  // Users shouldn't see the underlying model names (GLM, Claude, GPT, etc.)
  return 'PageSpace AI';
}

/**
 * Providers allowed in on-prem mode (local + BAA-eligible cloud).
 */
export const ONPREM_ALLOWED_PROVIDERS = new Set<string>(['ollama', 'lmstudio', 'azure_openai']);

/**
 * Providers exposed only to global admins (role === 'admin'), regardless of subscription tier.
 * Used to gate the paid OpenRouter provider to admins at both selection and generation time.
 */
export const ADMIN_ONLY_PROVIDERS = new Set<string>(['openrouter']);
export const isAdminOnlyProvider = (provider: string): boolean =>
  ADMIN_ONLY_PROVIDERS.has(provider);

/**
 * Providers whose model list is fetched dynamically at runtime.
 * These are exempt from the "model is required" validation on provider switch
 * because the client fetches the model list after selecting the provider.
 */
export const DYNAMIC_MODEL_PROVIDERS = new Set<string>(['ollama', 'lmstudio', 'openrouter_free']);

/**
 * Returns the provider entries visible in the current deployment mode.
 * On-prem: only local providers and Azure OpenAI.
 * Cloud: all providers.
 */
export function getVisibleProviders(): Partial<typeof AI_PROVIDERS> {
  // Client-side check uses NEXT_PUBLIC_ prefix; server-side uses DEPLOYMENT_MODE
  const mode =
    typeof window !== 'undefined'
      ? process.env.NEXT_PUBLIC_DEPLOYMENT_MODE
      : process.env.DEPLOYMENT_MODE;

  if (mode !== 'onprem') return AI_PROVIDERS;

  return Object.fromEntries(
    Object.entries(AI_PROVIDERS).filter(([key]) => ONPREM_ALLOWED_PROVIDERS.has(key))
  ) as Partial<typeof AI_PROVIDERS>;
}

