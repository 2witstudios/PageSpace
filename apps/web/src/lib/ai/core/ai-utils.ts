/**
 * AI provider credential resolution. Reads deployment env vars only —
 * per-user keys are no longer stored.
 */

export interface ManagedProviderKey {
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Resolves an AI provider's managed credentials from deployment env vars.
 * Returns null when the deployment hasn't configured this provider.
 */
export function getManagedProviderKey(provider: string): ManagedProviderKey | null {
  switch (provider) {
    case 'anthropic': {
      const apiKey = process.env.ANTHROPIC_DEFAULT_API_KEY;
      return apiKey ? { apiKey } : null;
    }
    case 'openai': {
      const apiKey = process.env.OPENAI_DEFAULT_API_KEY;
      return apiKey ? { apiKey } : null;
    }
    case 'google': {
      const apiKey = process.env.GOOGLE_AI_DEFAULT_API_KEY;
      return apiKey ? { apiKey } : null;
    }
    case 'xai': {
      const apiKey = process.env.XAI_DEFAULT_API_KEY;
      return apiKey ? { apiKey } : null;
    }
    case 'openrouter':
    case 'openrouter_free': {
      const apiKey = process.env.OPENROUTER_DEFAULT_API_KEY;
      return apiKey ? { apiKey } : null;
    }
    case 'glm': {
      const apiKey = process.env.GLM_CODER_DEFAULT_API_KEY;
      return apiKey ? { apiKey } : null;
    }
    case 'minimax': {
      const apiKey = process.env.MINIMAX_DEFAULT_API_KEY;
      return apiKey ? { apiKey } : null;
    }
    case 'ollama': {
      const baseUrl = process.env.OLLAMA_BASE_URL;
      return baseUrl ? { baseUrl } : null;
    }
    case 'lmstudio': {
      const baseUrl = process.env.LMSTUDIO_BASE_URL;
      return baseUrl ? { baseUrl } : null;
    }
    case 'azure_openai': {
      const apiKey = process.env.AZURE_OPENAI_API_KEY;
      const baseUrl = process.env.AZURE_OPENAI_ENDPOINT;
      return apiKey && baseUrl ? { apiKey, baseUrl } : null;
    }
    default:
      return null;
  }
}

/**
 * Gets the default PageSpace AI backend (GLM with Google/OpenRouter fallback).
 * Synchronous — only reads env vars; placeholder values like
 * `your_glm_api_key_here` are treated as unset so availability checks elsewhere
 * stay consistent with what `createAIProvider()` will accept.
 */
export function getDefaultPageSpaceSettings(): {
  apiKey: string;
  isConfigured: boolean;
  provider: 'glm' | 'google' | 'openrouter';
} | null {
  const glmApiKey = process.env.GLM_DEFAULT_API_KEY;
  if (glmApiKey && glmApiKey !== 'your_glm_api_key_here') {
    return { apiKey: glmApiKey, isConfigured: true, provider: 'glm' };
  }

  const googleApiKey = process.env.GOOGLE_AI_DEFAULT_API_KEY;
  if (googleApiKey && googleApiKey !== 'your_google_ai_api_key_here') {
    return { apiKey: googleApiKey, isConfigured: true, provider: 'google' };
  }

  const openRouterApiKey = process.env.OPENROUTER_DEFAULT_API_KEY;
  if (openRouterApiKey) {
    return { apiKey: openRouterApiKey, isConfigured: true, provider: 'openrouter' };
  }

  return null;
}

/**
 * Every provider name `/api/ai/settings` and `/api/ai/chat` advertise.
 * Centralizing the list prevents drift between the two GET handlers.
 */
export const ALL_PROVIDER_NAMES = [
  'pagespace',
  'openrouter',
  'openrouter_free',
  'google',
  'openai',
  'anthropic',
  'xai',
  'ollama',
  'lmstudio',
  'glm',
  'minimax',
  'azure_openai',
] as const;
export type ProviderName = (typeof ALL_PROVIDER_NAMES)[number];

/**
 * Resolves whether the deployment can route AI calls through the given provider.
 * Combines env-var presence (via `getManagedProviderKey` / `getDefaultPageSpaceSettings`)
 * with the on-prem allowlist so the chat picker, settings page, and PATCH guard
 * stay in lockstep.
 */
export function isProviderAvailable(
  provider: string,
  options: { isOnPrem: boolean; onPremAllowed: ReadonlySet<string> }
): boolean {
  if (options.isOnPrem && provider !== 'pagespace' && !options.onPremAllowed.has(provider)) {
    return false;
  }
  if (provider === 'pagespace') {
    return getDefaultPageSpaceSettings() !== null;
  }
  return getManagedProviderKey(provider) !== null;
}

/**
 * Builds the `{ [provider]: { isAvailable } }` map both AI GET routes return.
 */
export function buildProviderAvailabilityMap(options: {
  isOnPrem: boolean;
  onPremAllowed: ReadonlySet<string>;
}): Record<ProviderName, { isAvailable: boolean }> {
  const result = {} as Record<ProviderName, { isAvailable: boolean }>;
  for (const name of ALL_PROVIDER_NAMES) {
    result[name] = { isAvailable: isProviderAvailable(name, options) };
  }
  return result;
}
