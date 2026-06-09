import { describe, it, expect, afterEach } from 'vitest';
import {
  ONPREM_ALLOWED_PROVIDERS,
  ADMIN_ONLY_PROVIDERS,
  AI_PROVIDERS,
  FREE_TIER_MODELS,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  isModelAllowedForTier,
  getBackendProvider,
  getDefaultModel,
  getModelDisplayName,
  getUserFacingModelName,
  getVisibleProviders,
  isDynamicModelProvider,
  validateAgentModelSelection,
  resolveProviderModel,
} from '../ai-providers-config';

describe('ai-providers-config', () => {
  describe('catalog shape', () => {
    it('groups models under real vendor providers (no retired pagespace/openrouter virtuals)', () => {
      expect(AI_PROVIDERS).toHaveProperty('openai');
      expect(AI_PROVIDERS).toHaveProperty('anthropic');
      expect(AI_PROVIDERS).toHaveProperty('google');
      expect(AI_PROVIDERS).not.toHaveProperty('pagespace');
      expect(AI_PROVIDERS).not.toHaveProperty('openrouter');
      expect(AI_PROVIDERS).not.toHaveProperty('openrouter_free');
    });

    it('includes the admin glm direct provider with Coder Plan models', () => {
      // Admin-only direct Z.ai Coder Plan connection: bare glm-* native ids.
      expect(AI_PROVIDERS).toHaveProperty('glm');
      expect(AI_PROVIDERS.glm.name).toBe('Z.ai (Admin)');
      expect(AI_PROVIDERS.glm.models).toHaveProperty('glm-5.1');
      expect(AI_PROVIDERS.glm.models).toHaveProperty('glm-5-turbo');
      expect(AI_PROVIDERS.glm.models).toHaveProperty('glm-4.7');
      expect(AI_PROVIDERS.glm.models).toHaveProperty('glm-4.5-air');
    });

    it('includes the public zai provider with OpenRouter z-ai/ models', () => {
      // Public, OpenRouter-backed GLM family — metered normally, available to all.
      expect(AI_PROVIDERS).toHaveProperty('zai');
      expect(AI_PROVIDERS.zai.name).toBe('Z.ai');
      expect(AI_PROVIDERS.zai.models).toHaveProperty('z-ai/glm-5.1');
      expect(AI_PROVIDERS.zai.models).toHaveProperty('z-ai/glm-4.6');
      expect(AI_PROVIDERS.zai.models).toHaveProperty('z-ai/glm-4.5v');
      // Public zai keys are vendor-prefixed; every key carries the z-ai/ prefix.
      expect(Object.keys(AI_PROVIDERS.zai.models).every((m) => m.startsWith('z-ai/'))).toBe(true);
    });

    it('gates the admin glm provider, not the public zai provider', () => {
      expect(ADMIN_ONLY_PROVIDERS.has('glm')).toBe(true);
      expect(ADMIN_ONLY_PROVIDERS.has('zai')).toBe(false);
    });

    it('uses full OpenRouter model ids as keys for cloud vendors', () => {
      expect(AI_PROVIDERS.openai.models).toHaveProperty('openai/gpt-5.3-chat');
      expect(AI_PROVIDERS.anthropic.models).toHaveProperty('anthropic/claude-haiku-4.5');
      expect(AI_PROVIDERS.minimax.models).toHaveProperty('minimax/minimax-m3');
    });
  });

  describe('FREE_TIER_MODELS', () => {
    it('contains the curated free allowlist', () => {
      expect(FREE_TIER_MODELS.has('openai/gpt-5.3-chat')).toBe(true);
      expect(FREE_TIER_MODELS.has('openai/gpt-5.4-nano')).toBe(true);
      expect(FREE_TIER_MODELS.has('openai/gpt-5.4-mini')).toBe(true);
      expect(FREE_TIER_MODELS.has('anthropic/claude-haiku-4.5')).toBe(true);
      expect(FREE_TIER_MODELS.has('google/gemini-3.5-flash')).toBe(true);
    });

    it('does NOT contain frontier models', () => {
      expect(FREE_TIER_MODELS.has('anthropic/claude-opus-4.8')).toBe(false);
      expect(FREE_TIER_MODELS.has('openai/gpt-5.5-pro')).toBe(false);
    });

    it('every free model is a valid catalog model', () => {
      const allModels = new Set(
        Object.values(AI_PROVIDERS).flatMap((p) => Object.keys(p.models))
      );
      for (const m of FREE_TIER_MODELS) {
        expect(allModels.has(m)).toBe(true);
      }
    });

    it('DEFAULT_MODEL is in the free allowlist and valid', () => {
      expect(FREE_TIER_MODELS.has(DEFAULT_MODEL)).toBe(true);
      expect(AI_PROVIDERS[DEFAULT_PROVIDER as keyof typeof AI_PROVIDERS].models)
        .toHaveProperty(DEFAULT_MODEL);
    });
  });

  describe('isModelAllowedForTier', () => {
    it('allows any paid tier the full catalog', () => {
      expect(isModelAllowedForTier('anthropic/claude-opus-4.8', 'pro')).toBe(true);
      expect(isModelAllowedForTier('anthropic/claude-opus-4.8', 'founder')).toBe(true);
      expect(isModelAllowedForTier('anthropic/claude-opus-4.8', 'business')).toBe(true);
    });

    it('limits free tier to the allowlist', () => {
      expect(isModelAllowedForTier('openai/gpt-5.3-chat', 'free')).toBe(true);
      expect(isModelAllowedForTier('anthropic/claude-opus-4.8', 'free')).toBe(false);
    });

    it('treats undefined/unknown tier as free', () => {
      expect(isModelAllowedForTier('openai/gpt-5.3-chat', undefined)).toBe(true);
      expect(isModelAllowedForTier('anthropic/claude-opus-4.8', undefined)).toBe(false);
    });
  });

  describe('getBackendProvider', () => {
    it('routes cloud vendors through openrouter', () => {
      expect(getBackendProvider('openai')).toBe('openrouter');
      expect(getBackendProvider('anthropic')).toBe('openrouter');
      expect(getBackendProvider('minimax')).toBe('openrouter');
    });

    it('routes the public zai provider through openrouter', () => {
      expect(getBackendProvider('zai')).toBe('openrouter');
    });

    it('passes local providers through', () => {
      expect(getBackendProvider('ollama')).toBe('ollama');
      expect(getBackendProvider('lmstudio')).toBe('lmstudio');
      expect(getBackendProvider('azure_openai')).toBe('azure_openai');
    });

    it('routes glm direct (not through openrouter)', () => {
      expect(getBackendProvider('glm')).toBe('glm');
    });
  });

  describe('resolveProviderModel', () => {
    it('uses the request pair when both are present and valid', () => {
      expect(resolveProviderModel('anthropic', 'anthropic/claude-opus-4.8')).toEqual({
        provider: 'anthropic',
        model: 'anthropic/claude-opus-4.8',
      });
    });

    it('keeps the admin glm provider when the model is a valid glm model', () => {
      expect(resolveProviderModel('glm', 'glm-4.7')).toEqual({ provider: 'glm', model: 'glm-4.7' });
    });

    it('SUBSTITUTES the metered default when glm is paired with an invalid model (the P1 gate-bypass)', () => {
      // This is the exact vector Codex flagged: `glm` + an invalid model must NOT
      // resolve to glm (which would skip the credit gate) — it falls back to the
      // metered default, so the gate runs.
      const resolved = resolveProviderModel('glm', 'not-a-real-model');
      expect(resolved).toEqual({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL });
    });

    it('substitutes the default for any unknown (provider, model) pair', () => {
      expect(resolveProviderModel('openai', 'openai/hallucinated')).toEqual({
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODEL,
      });
    });

    it('falls back to the stored pair when the request pair is incomplete', () => {
      expect(resolveProviderModel(undefined, undefined, 'anthropic', 'anthropic/claude-opus-4.8')).toEqual({
        provider: 'anthropic',
        model: 'anthropic/claude-opus-4.8',
      });
      // A partial request (provider only) does not combine with a stored model.
      expect(resolveProviderModel('glm', undefined, 'anthropic', 'anthropic/claude-opus-4.8')).toEqual({
        provider: 'anthropic',
        model: 'anthropic/claude-opus-4.8',
      });
    });

    it('falls back to the default pair when nothing valid is provided', () => {
      expect(resolveProviderModel(undefined, undefined)).toEqual({
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODEL,
      });
    });

    it('preserves local/dynamic providers without catalog validation', () => {
      // ollama serves runtime-discovered models, so its bare model id is not substituted.
      expect(resolveProviderModel('ollama', 'llama3.1:70b-custom')).toEqual({
        provider: 'ollama',
        model: 'llama3.1:70b-custom',
      });
    });
  });

  describe('getDefaultModel', () => {
    it('returns the first model of a vendor', () => {
      expect(getDefaultModel('openai')).toBe('openai/gpt-5.5-pro');
    });

    it('returns DEFAULT_MODEL for an unknown provider', () => {
      expect(getDefaultModel('unknown-provider')).toBe(DEFAULT_MODEL);
    });
  });

  describe('getVisibleProviders', () => {
    const origNextPublic = process.env.NEXT_PUBLIC_DEPLOYMENT_MODE;
    const origServer = process.env.DEPLOYMENT_MODE;

    afterEach(() => {
      process.env.NEXT_PUBLIC_DEPLOYMENT_MODE = origNextPublic;
      process.env.DEPLOYMENT_MODE = origServer;
    });

    it('given cloud mode, should include all external providers', () => {
      delete process.env.NEXT_PUBLIC_DEPLOYMENT_MODE;
      delete process.env.DEPLOYMENT_MODE;
      const providers = getVisibleProviders();
      expect(providers).toHaveProperty('anthropic');
      expect(providers).toHaveProperty('openai');
      expect(providers).toHaveProperty('google');
      expect(providers).toHaveProperty('xai');
    });

    it('given onprem mode, should include only ONPREM_ALLOWED_PROVIDERS', () => {
      process.env.NEXT_PUBLIC_DEPLOYMENT_MODE = 'onprem';
      process.env.DEPLOYMENT_MODE = 'onprem';
      const providers = getVisibleProviders();
      expect(providers).not.toHaveProperty('anthropic');
      expect(providers).not.toHaveProperty('openai');
      Object.keys(providers).forEach((key) => {
        expect(ONPREM_ALLOWED_PROVIDERS.has(key)).toBe(true);
      });
    });

    it('given tenant mode, should include all external providers', () => {
      process.env.NEXT_PUBLIC_DEPLOYMENT_MODE = 'tenant';
      process.env.DEPLOYMENT_MODE = 'tenant';
      const providers = getVisibleProviders();
      expect(providers).toHaveProperty('anthropic');
      expect(providers).toHaveProperty('openai');
      expect(providers).toHaveProperty('google');
    });
  });

  describe('getModelDisplayName / getUserFacingModelName', () => {
    it('returns the real model display name', () => {
      expect(getModelDisplayName('openai', 'openai/gpt-5.3-chat')).toBe('GPT-5.3 Chat');
      expect(getUserFacingModelName('openai', 'openai/gpt-5.3-chat')).toBe('GPT-5.3 Chat');
      expect(getUserFacingModelName('anthropic', 'anthropic/claude-haiku-4.5')).toBe('Claude Haiku 4.5');
    });

    it('falls back to the raw model id for unknown models', () => {
      expect(getUserFacingModelName('openai', 'openai/does-not-exist')).toBe('openai/does-not-exist');
    });

    it('returns AI for a null/undefined model', () => {
      expect(getUserFacingModelName('openai', null)).toBe('AI');
      expect(getUserFacingModelName('openai', undefined)).toBe('AI');
    });
  });

  describe('isDynamicModelProvider', () => {
    it('is true for runtime-discovered providers', () => {
      expect(isDynamicModelProvider('ollama')).toBe(true);
      expect(isDynamicModelProvider('lmstudio')).toBe(true);
      expect(isDynamicModelProvider('azure_openai')).toBe(true);
    });

    it('is false for static cloud providers', () => {
      expect(isDynamicModelProvider('openai')).toBe(false);
      expect(isDynamicModelProvider('anthropic')).toBe(false);
    });
  });

  describe('validateAgentModelSelection', () => {
    const origNextPublic = process.env.NEXT_PUBLIC_DEPLOYMENT_MODE;
    const origServer = process.env.DEPLOYMENT_MODE;

    afterEach(() => {
      process.env.NEXT_PUBLIC_DEPLOYMENT_MODE = origNextPublic;
      process.env.DEPLOYMENT_MODE = origServer;
    });

    it('accepts a valid (provider, model) pair', () => {
      expect(validateAgentModelSelection('openai', 'openai/gpt-5.3-chat')).toBeNull();
      expect(validateAgentModelSelection('anthropic', 'anthropic/claude-opus-4.8')).toBeNull();
    });

    it('rejects a hallucinated model for a real provider', () => {
      const reason = validateAgentModelSelection('openai', 'openai/gpt-6-ultra');
      expect(reason).toMatch(/not a valid model/i);
    });

    it('rejects an unknown provider', () => {
      const reason = validateAgentModelSelection('acme', 'acme/whatever');
      expect(reason).toMatch(/unknown or unavailable/i);
    });

    it('rejects a model with no provider (null/empty) — closes the bypass', () => {
      expect(validateAgentModelSelection(null, 'openai/gpt-6-ultra')).toMatch(/provider/i);
      expect(validateAgentModelSelection('', 'openai/whatever')).toMatch(/provider/i);
      expect(validateAgentModelSelection(undefined, 'anything')).toMatch(/provider/i);
    });

    it('allows a provider with no model (model can default later)', () => {
      expect(validateAgentModelSelection('openai', null)).toBeNull();
      expect(validateAgentModelSelection('openai', '')).toBeNull();
    });

    it('allows any model for dynamic/local providers (runtime-discovered)', () => {
      expect(validateAgentModelSelection('ollama', 'llama3.1:70b-custom')).toBeNull();
      expect(validateAgentModelSelection('lmstudio', 'some-local-model')).toBeNull();
      expect(validateAgentModelSelection('azure_openai', 'my-deployment')).toBeNull();
    });

    it('treats clearing (both unset) as acceptable', () => {
      expect(validateAgentModelSelection(null, null)).toBeNull();
      expect(validateAgentModelSelection('', '')).toBeNull();
      expect(validateAgentModelSelection(undefined, undefined)).toBeNull();
    });

    it('respects deployment-mode visibility (cloud provider rejected on-prem)', () => {
      process.env.NEXT_PUBLIC_DEPLOYMENT_MODE = 'onprem';
      process.env.DEPLOYMENT_MODE = 'onprem';
      const reason = validateAgentModelSelection('openai', 'openai/gpt-5.3-chat');
      expect(reason).toMatch(/unknown or unavailable/i);
    });
  });
});
