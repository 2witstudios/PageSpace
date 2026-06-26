import { describe, it, expect, vi, afterEach } from 'vitest';
import { requiresProSubscription } from '../rate-limit-middleware';
import { FREE_TIER_MODELS, DEFAULT_MODEL } from '@/lib/ai/core/ai-providers-config';

// A model that is NOT in the free allowlist (a paid frontier model).
const PAID_MODEL = 'anthropic/claude-opus-4.8';
// A model that IS in the free allowlist.
const FREE_MODEL = DEFAULT_MODEL; // 'openai/gpt-5.3-codex', a member of FREE_TIER_MODELS

describe('Rate Limit Middleware', () => {
  describe('requiresProSubscription()', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('sanity: PAID_MODEL is not in the free allowlist and FREE_MODEL is', () => {
      expect(FREE_TIER_MODELS.has(PAID_MODEL)).toBe(false);
      expect(FREE_TIER_MODELS.has(FREE_MODEL)).toBe(true);
    });

    it('does not gate when billing is disabled (tenant mode)', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'tenant');
      expect(requiresProSubscription('anthropic', PAID_MODEL, 'free')).toBe(false);
    });

    it('does not gate when billing is disabled (onprem mode)', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'onprem');
      expect(requiresProSubscription('anthropic', PAID_MODEL, 'free')).toBe(false);
    });

    it('allows a free user a free-allowlist model in cloud mode', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      expect(requiresProSubscription('openai', FREE_MODEL, 'free')).toBe(false);
    });

    it('blocks a free user from a non-allowlist model in cloud mode', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      expect(requiresProSubscription('anthropic', PAID_MODEL, 'free')).toBe(true);
    });

    it('blocks an undefined-tier user from a non-allowlist model in cloud mode', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      expect(requiresProSubscription('anthropic', PAID_MODEL, undefined)).toBe(true);
    });

    it('allows an undefined-tier user a free-allowlist model in cloud mode', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      expect(requiresProSubscription('openai', FREE_MODEL, undefined)).toBe(false);
    });

    it('blocks a free user when no model is supplied (undefined model is not on the allowlist)', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      expect(requiresProSubscription('openai', undefined, 'free')).toBe(true);
    });

    it('does not gate the business tier on any model in cloud mode', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      expect(requiresProSubscription('anthropic', PAID_MODEL, 'business')).toBe(false);
    });

    it('does not gate the pro tier on any model in cloud mode', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      expect(requiresProSubscription('anthropic', PAID_MODEL, 'pro')).toBe(false);
    });

    it('does not gate the founder tier on any model in cloud mode', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      expect(requiresProSubscription('anthropic', PAID_MODEL, 'founder')).toBe(false);
    });

    it('treats any non-free truthy tier as paid (full catalog) in cloud mode', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      // Any truthy tier other than 'free' gets the full catalog.
      expect(requiresProSubscription('anthropic', PAID_MODEL, 'enterprise')).toBe(false);
    });

    it('lets an admin bypass the gate entirely on a free tier in cloud mode', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      expect(requiresProSubscription('anthropic', PAID_MODEL, 'free', true)).toBe(false);
    });
  });
});
