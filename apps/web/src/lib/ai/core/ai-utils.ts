/**
 * AI provider credential resolution. Reads deployment env vars only —
 * per-user keys are no longer stored.
 *
 * Every cloud vendor is served through OpenRouter, so all cloud providers resolve
 * to the single `OPENROUTER_DEFAULT_API_KEY`. Local providers (Ollama, LM Studio,
 * Azure OpenAI) resolve to their own deployment-level config for on-prem.
 */

import { getBackendProvider } from './ai-providers-config';

export interface ManagedProviderKey {
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Resolves an AI provider's managed credentials from deployment env vars.
 * Returns null when the deployment hasn't configured this provider.
 */
export function getManagedProviderKey(provider: string): ManagedProviderKey | null {
  // Cloud vendors (and the literal `openrouter` backend) all route through OpenRouter.
  if (getBackendProvider(provider) === 'openrouter') {
    const apiKey = process.env.OPENROUTER_DEFAULT_API_KEY;
    return apiKey ? { apiKey } : null;
  }

  switch (provider) {
    // Voice (STT/TTS) calls api.openai.com directly — not via OpenRouter — so it
    // needs the real OpenAI key. Kept distinct from the OpenRouter-backed `openai`
    // chat provider above.
    case 'openai_voice': {
      const apiKey = process.env.OPENAI_DEFAULT_API_KEY;
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
    case 'glm': {
      const apiKey = process.env.GLM_CODER_DEFAULT_API_KEY;
      return apiKey ? { apiKey } : null;
    }
    default:
      return null;
  }
}

/**
 * Every provider name `/api/ai/settings` and `/api/ai/chat` advertise.
 * Centralizing the list prevents drift between the two GET handlers.
 */
export const ALL_PROVIDER_NAMES = [
  // Cloud vendors (all OpenRouter-backed)
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'qwen',
  'mistral',
  'moonshot',
  'minimax',
  'meta',
  'bytedance',
  'ai21',
  'inception',
  'writer',
  'zai', // public OpenRouter-backed GLM family (z-ai/glm-*); distinct from admin-only `glm`
  // Local / on-prem
  'ollama',
  'lmstudio',
  'azure_openai',
  // Direct providers (own credentials, not OpenRouter-backed)
  'glm',
] as const;
export type ProviderName = (typeof ALL_PROVIDER_NAMES)[number];

/**
 * Resolves whether the deployment can route AI calls through the given provider.
 * Combines env-var presence (via `getManagedProviderKey`) with the on-prem
 * allowlist so the chat picker, settings page, and PATCH guard stay in lockstep.
 */
export function isProviderAvailable(
  provider: string,
  options: { isOnPrem: boolean; onPremAllowed: ReadonlySet<string> }
): boolean {
  if (options.isOnPrem && !options.onPremAllowed.has(provider)) {
    return false;
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
