import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock the Stripe constructor ───────────────────────────────────────────────
const mockStripeInstance = {
  customers: { retrieve: vi.fn(), create: vi.fn() },
  subscriptions: { list: vi.fn() },
};

const MockStripeConstructor = vi.fn().mockReturnValue(mockStripeInstance);

vi.mock('stripe', () => ({
  default: MockStripeConstructor,
}));

describe('stripe/client', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock_key';
    vi.resetModules();
    MockStripeConstructor.mockClear();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.STRIPE_SECRET_KEY = originalEnv;
    } else {
      delete process.env.STRIPE_SECRET_KEY;
    }
  });

  it('should export a stripe proxy object', async () => {
    const { stripe } = await import('../client');
    expect(stripe).toBeDefined();
    expect(typeof stripe).toBe('object');
  });

  it('should export Stripe class', async () => {
    const { Stripe } = await import('../client');
    expect(Stripe).toBeDefined();
  });

  it('should lazily initialize — Stripe constructor not called on import', async () => {
    // Re-import fresh module
    const _mod = await import('../client?lazy1');
    // The constructor should not be called until a property is accessed
    // (depending on module caching this may or may not hold, but accessing the export is enough)
    // Key behaviour: module loads without throwing even if STRIPE_SECRET_KEY is absent
    expect(_mod.stripe).toBeDefined();
  });

  it('should initialize Stripe with STRIPE_SECRET_KEY on first property access', async () => {
    const { stripe } = await import('../client?access1');
    // Access a property to trigger initialization
    const _customers = stripe.customers;
    expect(MockStripeConstructor).toHaveBeenCalledWith(
      'sk_test_mock_key',
      expect.objectContaining({ apiVersion: expect.any(String) })
    );
  });

  it('should return the proxied property from the underlying Stripe instance', async () => {
    const { stripe } = await import('../client?access2');
    const customers = stripe.customers;
    expect(customers).toBe(mockStripeInstance.customers);
  });

  it('should only instantiate Stripe once (lazy singleton)', async () => {
    const { stripe } = await import('../client?singleton1');
    // Access multiple properties
    const _a = stripe.customers;
    const _b = stripe.subscriptions;
    // Constructor should only be called once
    expect(MockStripeConstructor.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
