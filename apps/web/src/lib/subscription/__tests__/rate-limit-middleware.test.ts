import { describe, it, expect, vi, afterEach } from 'vitest';
import { requiresProSubscription } from '../rate-limit-middleware';

describe('Rate Limit Middleware', () => {
  describe('requiresProSubscription()', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('should not require pro subscription in tenant mode', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'tenant');
      expect(requiresProSubscription('pagespace', 'pro-model', 'free')).toBe(false);
    });

    it('should not require pro subscription in onprem mode', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'onprem');
      expect(requiresProSubscription('pagespace', 'pro-model', 'free')).toBe(false);
    });

    it('should not require pro subscription for non-pro model in cloud mode', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      expect(requiresProSubscription('pagespace', undefined, 'free')).toBe(false);
    });

    it('should require pro subscription for pro model with free tier in cloud mode', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      expect(requiresProSubscription('pagespace', 'glm-5', 'free')).toBe(true);
    });

    it('should not require pro subscription for business tier in cloud mode', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      expect(requiresProSubscription('pagespace', 'some-model', 'business')).toBe(false);
    });

    it('should not require pro subscription for pro tier in cloud mode', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      expect(requiresProSubscription('pagespace', 'some-model', 'pro')).toBe(false);
    });
  });
});
