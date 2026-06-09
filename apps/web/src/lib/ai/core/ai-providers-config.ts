/**
 * Centralized AI Provider Configuration
 * Single source of truth for all AI models across the application.
 *
 * Architecture: every cloud model is served through OpenRouter. Providers are
 * vendor *groupings* (OpenAI, Anthropic, Google, xAI, …) whose model keys are the
 * full OpenRouter model IDs (`openai/…`, `anthropic/…`, `x-ai/…`). `getBackendProvider`
 * maps all of them to the `openrouter` backend. Local providers (Ollama, LM Studio,
 * Azure OpenAI) keep their own backends for on-prem deployments.
 */

/**
 * OpenRouter response-cache TTL in seconds. Matches OpenRouter's default for the
 * `X-OpenRouter-Cache` header, so we don't need to send an explicit TTL header.
 */
export const OPENROUTER_CACHE_TTL_SECONDS = 300;

/**
 * Granularity (ms) the AI system-prompt timestamp is floored to. Derived from the
 * cache TTL so the two can never drift: a repeat request inside one cache window
 * produces a byte-identical request body, which is what lets the cache HIT.
 */
export const TIMESTAMP_BUCKET_MS = OPENROUTER_CACHE_TTL_SECONDS * 1000;

/**
 * Default provider/model for new users and any unset fallback. OpenAI's GPT-5.3
 * Chat (via OpenRouter) is the product default and a member of the free allowlist.
 * Sourced from @pagespace/lib so apps (e.g. admin onboarding seed data) that can't
 * import this web module stay in lockstep with the web defaults.
 */
import { DEFAULT_AI_PROVIDER, DEFAULT_AI_MODEL } from '@pagespace/lib/ai/model-defaults';
export const DEFAULT_PROVIDER = DEFAULT_AI_PROVIDER;
export const DEFAULT_MODEL = DEFAULT_AI_MODEL;

/**
 * Server-side model defaults for background AI jobs (pulse, memory, onboarding,
 * workflows) that previously used the `standard`/`pro` PageSpace aliases. These are
 * concrete OpenRouter IDs so the jobs no longer depend on the removed alias layer.
 */
export const BACKGROUND_LIGHT_MODEL = 'anthropic/claude-haiku-4.5';
export const BACKGROUND_HEAVY_MODEL = 'anthropic/claude-sonnet-4.6';

/**
 * Providers restricted to admin users. These require a separate subscription
 * (not on PageSpace's OpenRouter quota) and route directly to the provider's API.
 * Non-admins receive a 403 "provider restricted" response rather than a subscription
 * upgrade prompt.
 */
export const ADMIN_ONLY_PROVIDERS = new Set<string>(['glm']);

/**
 * Models available to the FREE subscription tier. Every paid tier
 * (`pro`/`founder`/`business`) gets the full catalog; free users are limited to
 * this curated set of cheaper models. `DEFAULT_MODEL` must be a member.
 */
export const FREE_TIER_MODELS = new Set<string>([
  'openai/gpt-5.3-chat',
  'openai/gpt-5.4-nano',
  'openai/gpt-5.4-mini',
  'anthropic/claude-haiku-4.5',
  'google/gemini-3.5-flash',
  'google/gemini-3.1-flash-lite',
  'google/gemini-3-flash-preview',
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite',
]);

/**
 * Whether a (subscription tier) may select the given model.
 * Any paid tier → full catalog. Free / unknown / unset tier → free allowlist only.
 */
export function isModelAllowedForTier(model: string | undefined, tier: string | undefined): boolean {
  if (tier && tier !== 'free') return true;
  return !!model && FREE_TIER_MODELS.has(model);
}

export const AI_PROVIDERS = {
  openai: {
    name: 'OpenAI',
    models: {
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
      'openai/gpt-5.2': 'GPT-5.2',
      'openai/gpt-5.2-codex': 'GPT-5.2 Codex',
      'openai/gpt-5.1': 'GPT-5.1',
      'openai/gpt-5.1-chat': 'GPT-5.1 Chat',
      'openai/gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
      'openai/gpt-5.1-codex': 'GPT-5.1 Codex',
      'openai/gpt-5.1-codex-mini': 'GPT-5.1 Codex Mini',
      'openai/gpt-5-pro': 'GPT-5 Pro',
      'openai/gpt-5-codex': 'GPT-5 Codex',
      'openai/gpt-5': 'GPT-5',
      'openai/gpt-5-mini': 'GPT-5 Mini',
      'openai/gpt-5-nano': 'GPT-5 Nano',
      'openai/gpt-4o': 'GPT-4o',
      'openai/gpt-4o-mini': 'GPT-4o Mini',
      'openai/gpt-4.1': 'GPT-4.1',
      'openai/gpt-4.1-mini': 'GPT-4.1 Mini',
      'openai/o3': 'o3',
      'openai/o3-pro': 'o3 Pro',
      'openai/o4-mini': 'o4 Mini',
      'openai/o3-deep-research': 'o3 Deep Research',
      'openai/o4-mini-deep-research': 'o4 Mini Deep Research',
      'openai/gpt-oss-120b': 'GPT OSS 120B',
      'openai/gpt-oss-20b': 'GPT OSS 20B',
    },
  },
  anthropic: {
    name: 'Anthropic',
    models: {
      'anthropic/claude-opus-4.8': 'Claude Opus 4.8',
      'anthropic/claude-opus-4.8-fast': 'Claude Opus 4.8 Fast',
      'anthropic/claude-opus-4.7': 'Claude Opus 4.7',
      'anthropic/claude-opus-4.7-fast': 'Claude Opus 4.7 Fast',
      'anthropic/claude-opus-4.6': 'Claude Opus 4.6',
      'anthropic/claude-opus-4.6-fast': 'Claude Opus 4.6 Fast',
      'anthropic/claude-sonnet-4.6': 'Claude Sonnet 4.6',
      'anthropic/claude-opus-4.5': 'Claude Opus 4.5',
      'anthropic/claude-sonnet-4.5': 'Claude Sonnet 4.5',
      'anthropic/claude-haiku-4.5': 'Claude Haiku 4.5',
      'anthropic/claude-opus-4.1': 'Claude Opus 4.1',
      'anthropic/claude-opus-4': 'Claude Opus 4',
      'anthropic/claude-sonnet-4': 'Claude Sonnet 4',
      'anthropic/claude-3.5-haiku': 'Claude 3.5 Haiku',
      'anthropic/claude-3-haiku': 'Claude 3 Haiku',
    },
  },
  google: {
    name: 'Google',
    models: {
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
    },
  },
  xai: {
    name: 'xAI (Grok)',
    models: {
      'x-ai/grok-4.3': 'Grok 4.3',
      'x-ai/grok-4.20': 'Grok 4.20',
      'x-ai/grok-4.20-multi-agent': 'Grok 4.20 Multi-Agent',
      'x-ai/grok-build-0.1': 'Grok Build 0.1',
    },
  },
  deepseek: {
    name: 'DeepSeek',
    models: {
      'deepseek/deepseek-v4-pro': 'DeepSeek V4 Pro',
      'deepseek/deepseek-v4-flash': 'DeepSeek V4 Flash',
      'deepseek/deepseek-v3.2': 'DeepSeek V3.2',
      'deepseek/deepseek-v3.1-terminus': 'DeepSeek V3.1 Terminus',
      'deepseek/deepseek-r1-0528': 'DeepSeek R1',
    },
  },
  qwen: {
    name: 'Qwen',
    models: {
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
    },
  },
  mistral: {
    name: 'Mistral',
    models: {
      'mistralai/mistral-large-2512': 'Mistral Large 3',
      'mistralai/mistral-medium-3-5': 'Mistral Medium 3.5',
      'mistralai/mistral-small-2603': 'Mistral Small (2603)',
      'mistralai/mistral-medium-3.1': 'Mistral Medium 3.1',
      'mistralai/mistral-medium-3': 'Mistral Medium 3',
      'mistralai/mistral-small-3.2-24b-instruct': 'Mistral Small 3.2 24B',
      'mistralai/codestral-2508': 'Codestral 2508',
      'mistralai/devstral-2512': 'Devstral 2',
    },
  },
  moonshot: {
    name: 'Moonshot AI',
    models: {
      'moonshotai/kimi-k2.6': 'Kimi K2.6',
      'moonshotai/kimi-k2-thinking': 'Kimi K2 Thinking',
      'moonshotai/kimi-k2': 'Kimi K2',
    },
  },
  minimax: {
    name: 'MiniMax',
    models: {
      'minimax/minimax-m3': 'MiniMax M3',
      'minimax/minimax-m2.7': 'MiniMax M2.7',
      'minimax/minimax-m2.5': 'MiniMax M2.5',
      'minimax/minimax-m2.1': 'MiniMax M2.1',
      'minimax/minimax-m1': 'MiniMax M1',
    },
  },
  meta: {
    name: 'Meta (Llama)',
    models: {
      'meta-llama/llama-4-maverick': 'Llama 4 Maverick',
      'meta-llama/llama-4-scout': 'Llama 4 Scout',
      'meta-llama/llama-3.3-70b-instruct': 'Llama 3.3 70B',
    },
  },
  bytedance: {
    name: 'ByteDance',
    models: {
      'bytedance-seed/seed-2.0-lite': 'Seed 2.0 Lite',
      'bytedance-seed/seed-2.0-mini': 'Seed 2.0 Mini',
    },
  },
  ai21: {
    name: 'AI21',
    models: {
      'ai21/jamba-large-1.7': 'Jamba Large 1.7',
    },
  },
  inception: {
    name: 'Inception',
    models: {
      'inception/mercury-2': 'Mercury 2',
    },
  },
  writer: {
    name: 'Writer',
    models: {
      'writer/palmyra-x5': 'Palmyra X5',
    },
  },
  glm: {
    name: 'Z.ai (GLM)',
    models: {
      'glm-5.1':       'GLM-5.1',
      'glm-5v-turbo':  'GLM-5V Turbo',
      'glm-5-turbo':   'GLM-5 Turbo',
      'glm-5':         'GLM-5',
      'glm-4.7':       'GLM-4.7',
      'glm-4.7-flash': 'GLM-4.7 Flash',
      'glm-4.6v':      'GLM-4.6V',
      'glm-4.6':       'GLM-4.6',
      'glm-4.5v':      'GLM-4.5V',
      'glm-4.5':       'GLM-4.5',
      'glm-4.5-air':   'GLM-4.5 Air',
      'glm-4-32b':     'GLM-4 32B',
    },
  },
  ollama: {
    name: 'Ollama (Local)',
    models: {
      // Discovered dynamically from the local Ollama instance.
    },
  },
  lmstudio: {
    name: 'LM Studio (Local)',
    models: {
      // Discovered dynamically from the running LM Studio instance.
    },
  },
  azure_openai: {
    name: 'Azure OpenAI',
    models: {
      // Deployment-name driven; discovered dynamically.
    },
  },
} as const;

/**
 * Cloud vendor providers — every one is served through OpenRouter. The remainder
 * (Ollama, LM Studio, Azure OpenAI) keep their own backends for on-prem.
 */
const CLOUD_VENDOR_PROVIDERS = new Set<string>([
  'openai', 'anthropic', 'google', 'xai', 'deepseek', 'qwen', 'mistral',
  'moonshot', 'minimax', 'meta', 'bytedance', 'ai21', 'inception', 'writer',
]);

/**
 * Map a UI provider to its backend. Every cloud vendor routes through OpenRouter;
 * local providers use their own backend.
 */
export function getBackendProvider(uiProvider: string): string {
  if (CLOUD_VENDOR_PROVIDERS.has(uiProvider)) return 'openrouter';
  return uiProvider;
}

/**
 * Get default model for a provider (first model in its catalog).
 */
export function getDefaultModel(provider: string): string {
  const providerConfig = AI_PROVIDERS[provider as keyof typeof AI_PROVIDERS];
  if (!providerConfig) return DEFAULT_MODEL;
  const models = Object.keys(providerConfig.models);
  return models[0] ?? '';
}

/**
 * Check if a model is valid for a provider.
 */
export function isValidModel(provider: string, model: string): boolean {
  const providerConfig = AI_PROVIDERS[provider as keyof typeof AI_PROVIDERS];
  if (!providerConfig) return false;
  return model in providerConfig.models;
}

/**
 * Get display name for a model.
 */
export function getModelDisplayName(provider: string, model: string): string {
  const providerConfig = AI_PROVIDERS[provider as keyof typeof AI_PROVIDERS];
  if (!providerConfig) return model;
  return providerConfig.models[model as keyof typeof providerConfig.models] || model;
}

export type AIProvider = keyof typeof AI_PROVIDERS;
export type AIModel<T extends AIProvider> = keyof typeof AI_PROVIDERS[T]['models'];

/**
 * User-facing display name for an AI (provider, model) pair. Returns the real
 * model display name from the catalog, falling back to the raw model id.
 */
export function getUserFacingModelName(provider: string | null | undefined, model: string | null | undefined): string {
  if (!model) return 'AI';
  if (provider) {
    const name = getModelDisplayName(provider, model);
    if (name) return name;
  }
  return model;
}

/**
 * Providers allowed in on-prem mode (local + BAA-eligible cloud).
 */
export const ONPREM_ALLOWED_PROVIDERS = new Set<string>(['ollama', 'lmstudio', 'azure_openai']);

/**
 * Providers whose model list is fetched dynamically at runtime. These are exempt
 * from the "model is required" validation on provider switch because the client
 * fetches the model list after selecting the provider.
 */
export const DYNAMIC_MODEL_PROVIDERS = new Set<string>(['ollama', 'lmstudio']);

/**
 * Returns the provider entries visible in the current deployment mode.
 * On-prem: only local providers and Azure OpenAI. Cloud: all providers.
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

/**
 * Providers whose model catalog is empty in `AI_PROVIDERS` because their models
 * are discovered at runtime (local Ollama/LM Studio instances, Azure deployment
 * names). Model-id validation must short-circuit to "allow" for these — there is
 * no static list to check a selection against. Supersets `DYNAMIC_MODEL_PROVIDERS`
 * with `azure_openai` (also deployment-name driven).
 */
const DYNAMIC_CATALOG_PROVIDERS = new Set<string>([...DYNAMIC_MODEL_PROVIDERS, 'azure_openai']);

/**
 * Whether the provider's models are discovered at runtime (so the static catalog
 * has no entries to validate against).
 */
export function isDynamicModelProvider(provider: string): boolean {
  return DYNAMIC_CATALOG_PROVIDERS.has(provider);
}

/**
 * Validate an agent's (provider, model) selection against the real catalog so a
 * hallucinated model id can never be stored. Returns `null` when the selection is
 * acceptable, otherwise a human-readable reason string.
 *
 * This is the anti-hallucination gate, NOT a tier gate — subscription-tier access
 * is enforced where the call is made (`isModelAllowedForTier`). Clearing the config
 * (both unset) is allowed, dynamic/local providers are allowed (runtime-discovered
 * models), and deployment-mode visibility is respected via `getVisibleProviders`.
 */
export function validateAgentModelSelection(
  provider: string | null | undefined,
  model: string | null | undefined,
): string | null {
  if (!provider && !model) return null; // clearing/unset is fine
  // A model can't be stored without a provider — the pair is what gets validated
  // and routed. Without a provider there's nothing to check the model against, so
  // a hallucinated id would otherwise slip through.
  if (model && !provider) {
    return `Set an AI provider alongside model "${model}".`;
  }
  const visible = getVisibleProviders();
  if (provider && !(provider in visible)) {
    return `Unknown or unavailable AI provider "${provider}".`;
  }
  if (isDynamicModelProvider(provider ?? '')) return null; // ollama/lmstudio/azure: runtime-discovered
  if (model && provider && !isValidModel(provider, model)) {
    return `Model "${model}" is not a valid model for provider "${provider}".`;
  }
  return null;
}
