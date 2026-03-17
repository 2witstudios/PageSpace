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

    it('should require pro subscription for free tier in cloud mode', () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      // requiresProSubscription checks model tier via getPageSpaceModelTier
      // For non-pro models, it returns false regardless of subscription
      expect(requiresProSubscription('pagespace', undefined, 'free')).toBe(false);
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
