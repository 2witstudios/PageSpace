import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We need to test the getStripeMode logic which runs at module load time.
// Re-import the module fresh for each scenario using dynamic imports.

describe('stripe-config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env to clean state
    delete process.env.NEXT_PUBLIC_STRIPE_MODE;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    // Restore original env
    Object.assign(process.env, originalEnv);
    vi.resetModules();
  });

  describe('getStripeMode via stripeMode export', () => {
    it('should return test mode when NEXT_PUBLIC_STRIPE_MODE is test', async () => {
      process.env.NEXT_PUBLIC_STRIPE_MODE = 'test';
      const { stripeMode } = await import('../stripe-config?test1');
      expect(stripeMode).toBe('test');
    });

    it('should return live mode when NEXT_PUBLIC_STRIPE_MODE is live', async () => {
      process.env.NEXT_PUBLIC_STRIPE_MODE = 'live';
      const { stripeMode } = await import('../stripe-config?live1');
      expect(stripeMode).toBe('live');
    });

    it('should ignore invalid NEXT_PUBLIC_STRIPE_MODE values and fall back', async () => {
      process.env.NEXT_PUBLIC_STRIPE_MODE = 'invalid' as 'test';
      process.env.NODE_ENV = 'development';
      const { stripeMode } = await import('../stripe-config?invalid');
      expect(stripeMode).toBe('test');
    });

    it('should return live when NODE_ENV is production and live key is configured', async () => {
      delete process.env.NEXT_PUBLIC_STRIPE_MODE;
      process.env.NODE_ENV = 'production';
      const { stripeMode } = await import('../stripe-config?prod');
      // The live publishableKey is non-empty, so it should be 'live'
      expect(stripeMode).toBe('live');
    });

    it('should return test when NODE_ENV is not production', async () => {
      delete process.env.NEXT_PUBLIC_STRIPE_MODE;
      process.env.NODE_ENV = 'development';
      const { stripeMode } = await import('../stripe-config?dev');
      expect(stripeMode).toBe('test');
    });

    it('should default to test when no env vars are set', async () => {
      delete process.env.NEXT_PUBLIC_STRIPE_MODE;
      delete process.env.NODE_ENV;
      const { stripeMode } = await import('../stripe-config?noenv');
      expect(stripeMode).toBe('test');
    });
  });

  describe('stripeConfig export', () => {
    it('should export a config with publishableKey and priceIds in test mode', async () => {
      process.env.NEXT_PUBLIC_STRIPE_MODE = 'test';
      const { stripeConfig } = await import('../stripe-config?testcfg');
      expect(stripeConfig).toBeDefined();
      expect(stripeConfig.publishableKey).toMatch(/^pk_test_/);
      expect(stripeConfig.priceIds).toHaveProperty('pro');
      expect(stripeConfig.priceIds).toHaveProperty('founder');
      expect(stripeConfig.priceIds).toHaveProperty('business');
    });

    it('should export a config with live publishableKey in live mode', async () => {
      process.env.NEXT_PUBLIC_STRIPE_MODE = 'live';
      const { stripeConfig } = await import('../stripe-config?livecfg');
      expect(stripeConfig.publishableKey).toMatch(/^pk_live_/);
    });

    it('should have non-empty price IDs in test mode', async () => {
      process.env.NEXT_PUBLIC_STRIPE_MODE = 'test';
      const { stripeConfig } = await import('../stripe-config?testprices');
      expect(stripeConfig.priceIds.pro).toBeTruthy();
      expect(stripeConfig.priceIds.founder).toBeTruthy();
      expect(stripeConfig.priceIds.business).toBeTruthy();
    });

    it('should have non-empty price IDs in live mode', async () => {
      process.env.NEXT_PUBLIC_STRIPE_MODE = 'live';
      const { stripeConfig } = await import('../stripe-config?liveprices');
      expect(stripeConfig.priceIds.pro).toBeTruthy();
      expect(stripeConfig.priceIds.founder).toBeTruthy();
      expect(stripeConfig.priceIds.business).toBeTruthy();
    });
  });
});
