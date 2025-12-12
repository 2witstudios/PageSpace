import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

// Mock Stripe - use vi.hoisted to ensure mocks are available before vi.mock
const { mockStripeWebhooksConstructEvent, StripeError, mockGetTierFromPrice } = vi.hoisted(() => {
  const StripeError = class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'StripeError';
    }
  };
  return {
    mockStripeWebhooksConstructEvent: vi.fn(),
    StripeError,
    mockGetTierFromPrice: vi.fn((priceId: string, priceAmount?: number) => {
      // Map price amounts to tiers for testing
      if (priceAmount === 1500 || priceAmount === 2999) return 'pro';
      if (priceAmount === 5000) return 'founder';
      if (priceAmount === 10000 || priceAmount === 19999) return 'business';
      return 'pro'; // Default fallback
    }),
  };
});

vi.mock('@/lib/stripe', () => ({
  stripe: {
    webhooks: {
      constructEvent: mockStripeWebhooksConstructEvent,
    },
  },
  Stripe: {
    errors: { StripeError },
  },
  getTierFromPrice: mockGetTierFromPrice,
}));

// Mock database
const mockSelectWhere = vi.fn();
const mockSelectLimit = vi.fn();
const mockInsertValues = vi.fn();
const mockInsertOnConflict = vi.fn();
const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn();

vi.mock('@pagespace/db', () => {
  // Create a mock transaction function
  const mockTx = {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      })),
    })),
    update: vi.fn(() => ({
      set: mockUpdateSet.mockReturnValue({
        where: mockUpdateWhere,
      }),
    })),
  };

  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: mockSelectWhere.mockReturnValue({
            limit: mockSelectLimit,
          }),
        })),
      })),
      insert: vi.fn(() => ({
        values: mockInsertValues.mockReturnValue({
          onConflictDoUpdate: mockInsertOnConflict,
        }),
      })),
      update: vi.fn(() => ({
        set: mockUpdateSet.mockReturnValue({
          where: mockUpdateWhere,
        }),
      })),
      transaction: vi.fn(async (callback: (tx: typeof mockTx) => Promise<void>) => {
        await callback(mockTx);
      }),
    },
    users: {},
    subscriptions: {},
    stripeEvents: {},
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  };
});

// Import after mocks
import { POST } from '../route';

// Helper to create mock Stripe event
const mockStripeEvent = (type: string, data: unknown): Stripe.Event => ({
  id: `evt_${Date.now()}`,
  type,
  data: {
    object: data,
  },
  api_version: '2025-08-27.basil',
  created: Math.floor(Date.now() / 1000),
  livemode: false,
  object: 'event',
  pending_webhooks: 0,
  request: null,
});

// Helper to create mock subscription
const mockSubscription = (overrides: Partial<{
  id: string;
  customer: string;
  status: string;
  priceAmount: number;
  cancelAtPeriodEnd: boolean;
}> = {}): Stripe.Subscription => ({
  id: overrides.id ?? 'sub_123',
  customer: overrides.customer ?? 'cus_123',
  status: (overrides.status ?? 'active') as Stripe.Subscription.Status,
  cancel_at_period_end: overrides.cancelAtPeriodEnd ?? false,
  items: {
    data: [{
      id: 'si_123',
      price: {
        id: 'price_123',
        unit_amount: overrides.priceAmount ?? 1500, // Default: $15 Pro
      },
      current_period_start: Math.floor(Date.now() / 1000),
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    }],
    object: 'list',
    has_more: false,
    url: '/v1/subscription_items',
  },
  object: 'subscription',
  application: null,
  application_fee_percent: null,
  automatic_tax: { enabled: false, liability: null },
  billing_cycle_anchor: Math.floor(Date.now() / 1000),
  billing_cycle_anchor_config: null,
  billing_thresholds: null,
  cancel_at: null,
  canceled_at: null,
  cancellation_details: null,
  collection_method: 'charge_automatically',
  created: Math.floor(Date.now() / 1000),
  currency: 'usd',
  current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  current_period_start: Math.floor(Date.now() / 1000),
  days_until_due: null,
  default_payment_method: null,
  default_source: null,
  description: null,
  discount: null,
  discounts: [],
  ended_at: null,
  invoice_settings: { account_tax_ids: null, issuer: { type: 'self' } },
  latest_invoice: null,
  livemode: false,
  metadata: {},
  next_pending_invoice_item_invoice: null,
  on_behalf_of: null,
  pause_collection: null,
  payment_settings: null,
  pending_invoice_item_interval: null,
  pending_setup_intent: null,
  pending_update: null,
  schedule: null,
  start_date: Math.floor(Date.now() / 1000),
  test_clock: null,
  transfer_data: null,
  trial_end: null,
  trial_settings: null,
  trial_start: null,
} as unknown as Stripe.Subscription);

// Helper to create mock invoice
const mockInvoice = (overrides: Partial<{
  id: string;
  customer: string;
  amountPaid: number;
}> = {}): Stripe.Invoice => ({
  id: overrides.id ?? 'in_123',
  customer: overrides.customer ?? 'cus_123',
  amount_paid: overrides.amountPaid ?? 1500,
  object: 'invoice',
} as Stripe.Invoice);

// Helper to create mock checkout session
const mockCheckoutSession = (overrides: Partial<{
  id: string;
  mode: string;
  customer: string;
  customerEmail: string;
}> = {}): Stripe.Checkout.Session => ({
  id: overrides.id ?? 'cs_123',
  mode: (overrides.mode ?? 'subscription') as Stripe.Checkout.Session.Mode,
  customer: overrides.customer ?? 'cus_123',
  customer_details: {
    email: overrides.customerEmail ?? 'test@example.com',
    name: null,
    address: null,
    phone: null,
    tax_exempt: 'none',
    tax_ids: null,
  },
  object: 'checkout.session',
} as Stripe.Checkout.Session);

// Helper to create mock user
const mockUser = (overrides: Partial<{
  id: string;
  stripeCustomerId: string;
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  stripeCustomerId: overrides.stripeCustomerId ?? 'cus_123',
});

describe('POST /api/stripe/webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set required environment variable
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';

    // Setup default database responses
    mockSelectLimit.mockResolvedValue([mockUser()]);
    mockInsertValues.mockReturnValue({
      onConflictDoUpdate: mockInsertOnConflict,
    });
    mockInsertOnConflict.mockResolvedValue(undefined);
    mockUpdateWhere.mockResolvedValue(undefined);
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  });

  describe('Signature Verification', () => {
    it('should return 400 when signature is missing', async () => {
      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: '{}',
        headers: {},
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Missing signature');
    });

    it('should return 400 when signature is invalid', async () => {
      mockStripeWebhooksConstructEvent.mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: '{}',
        headers: {
          'stripe-signature': 'invalid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid signature');
    });
  });

  describe('Idempotency', () => {
    it('should return 200 for duplicate events', async () => {
      const event = mockStripeEvent('customer.subscription.created', mockSubscription());
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      // Simulate duplicate event (insert throws conflict error)
      mockInsertValues.mockImplementation(() => {
        throw new Error('Duplicate key');
      });

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.received).toBe(true);
    });
  });

  describe('Subscription Events', () => {
    it('should handle subscription.created and update tier to pro', async () => {
      const subscription = mockSubscription({ priceAmount: 1500 }); // $15 = Pro
      const event = mockStripeEvent('customer.subscription.created', subscription);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.received).toBe(true);
      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptionTier: 'pro',
        })
      );
    });

    it('should handle subscription.updated and update tier to founder', async () => {
      const subscription = mockSubscription({ priceAmount: 5000 }); // $50 = Founder
      const event = mockStripeEvent('customer.subscription.updated', subscription);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.received).toBe(true);
      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptionTier: 'founder',
        })
      );
    });

    it('should handle subscription.deleted and downgrade to free', async () => {
      const subscription = mockSubscription({ status: 'canceled' });
      const event = mockStripeEvent('customer.subscription.deleted', subscription);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.received).toBe(true);
      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptionTier: 'free',
        })
      );
    });

    it('should skip and return 200 when user not found for subscription (warning only)', async () => {
      mockSelectLimit.mockResolvedValue([]); // No user found

      const subscription = mockSubscription();
      const event = mockStripeEvent('customer.subscription.created', subscription);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      // Now returns 200 with warning - doesn't fail webhook
      expect(response.status).toBe(200);
      expect(body.received).toBe(true);
    });
  });

  describe('Tier Detection from Price Amount', () => {
    const tierPriceTests = [
      { priceAmount: 1500, expectedTier: 'pro', description: '$15 = Pro (new)' },
      { priceAmount: 2999, expectedTier: 'pro', description: '$29.99 = Pro (legacy)' },
      { priceAmount: 5000, expectedTier: 'founder', description: '$50 = Founder (new)' },
      { priceAmount: 10000, expectedTier: 'business', description: '$100 = Business (new)' },
      { priceAmount: 19999, expectedTier: 'business', description: '$199.99 = Business (legacy)' },
      { priceAmount: 999, expectedTier: 'pro', description: 'Fallback to pro for unknown price' },
    ];

    for (const { priceAmount, expectedTier, description } of tierPriceTests) {
      it(`should detect ${description}`, async () => {
        const subscription = mockSubscription({ priceAmount });
        const event = mockStripeEvent('customer.subscription.created', subscription);
        mockStripeWebhooksConstructEvent.mockReturnValue(event);

        const request = new Request('https://example.com/api/stripe/webhook', {
          method: 'POST',
          body: JSON.stringify(event),
          headers: {
            'stripe-signature': 'valid_signature',
          },
        }) as unknown as import('next/server').NextRequest;

        const response = await POST(request);

        expect(response.status).toBe(200);
        expect(mockUpdateSet).toHaveBeenCalledWith(
          expect.objectContaining({
            subscriptionTier: expectedTier,
          })
        );
      });
    }

    it('should set tier to free when subscription not active', async () => {
      const subscription = mockSubscription({ status: 'past_due', priceAmount: 5000 });
      const event = mockStripeEvent('customer.subscription.updated', subscription);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptionTier: 'free',
        })
      );
    });

    it('should allow trialing subscriptions to have paid tier', async () => {
      const subscription = mockSubscription({ status: 'trialing', priceAmount: 5000 });
      const event = mockStripeEvent('customer.subscription.created', subscription);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptionTier: 'founder',
        })
      );
    });
  });

  describe('Invoice Events', () => {
    it('should handle invoice.payment_failed without error', async () => {
      const invoice = mockInvoice();
      const event = mockStripeEvent('invoice.payment_failed', invoice);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.received).toBe(true);
    });

    it('should handle invoice.payment_failed when user not found (warning only)', async () => {
      mockSelectLimit.mockResolvedValue([]); // No user found

      const invoice = mockInvoice();
      const event = mockStripeEvent('invoice.payment_failed', invoice);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      // Payment failed handler doesn't throw, just logs warning
      expect(response.status).toBe(200);
      expect(body.received).toBe(true);
    });

    it('should handle invoice.paid successfully', async () => {
      const invoice = mockInvoice({ amountPaid: 5000 });
      const event = mockStripeEvent('invoice.paid', invoice);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.received).toBe(true);
    });
  });

  describe('Checkout Session Events', () => {
    it('should handle checkout.session.completed and link customer', async () => {
      const session = mockCheckoutSession({
        mode: 'subscription',
        customer: 'cus_new123',
        customerEmail: 'test@example.com',
      });
      const event = mockStripeEvent('checkout.session.completed', session);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.received).toBe(true);
      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          stripeCustomerId: 'cus_new123',
        })
      );
    });

    it('should skip non-subscription checkout sessions', async () => {
      const session = mockCheckoutSession({ mode: 'payment' });
      const event = mockStripeEvent('checkout.session.completed', session);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.received).toBe(true);
      // Should not try to update stripeCustomerId
      expect(mockUpdateSet).not.toHaveBeenCalledWith(
        expect.objectContaining({
          stripeCustomerId: expect.any(String),
        })
      );
    });
  });

  describe('Unhandled Events', () => {
    it('should return 200 for unhandled event types', async () => {
      const event = mockStripeEvent('payment_intent.created', { id: 'pi_123' });
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.received).toBe(true);
    });
  });

  describe('Event Processing', () => {
    it('should mark event as processed successfully', async () => {
      const event = mockStripeEvent('invoice.paid', mockInvoice());
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      await POST(request);

      // Should update stripeEvents with processedAt
      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          processedAt: expect.any(Date),
        })
      );
    });

    it('should record event ID for idempotency', async () => {
      const event = mockStripeEvent('invoice.paid', mockInvoice());
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      await POST(request);

      expect(mockInsertValues).toHaveBeenCalledWith({
        id: event.id,
        type: event.type,
      });
    });
  });
});
