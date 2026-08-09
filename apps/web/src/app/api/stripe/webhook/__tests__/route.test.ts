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
const mockInsertOnConflictDoNothing = vi.fn();
const mockInsertReturning = vi.fn();
const mockTxInsertValues = vi.fn();
const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn();
const mockUpdateReturning = vi.fn();
const mockDeleteWhere = vi.fn();

vi.mock('@pagespace/db/db', () => {
  // Create a mock transaction function
  const mockTx = {
    insert: vi.fn(() => ({
      values: mockTxInsertValues.mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
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
          onConflictDoNothing: mockInsertOnConflictDoNothing.mockReturnValue({
            returning: mockInsertReturning,
          }),
        }),
      })),
      update: vi.fn(() => ({
        set: mockUpdateSet.mockReturnValue({
          where: mockUpdateWhere,
        }),
      })),
      delete: vi.fn(() => ({
        where: mockDeleteWhere,
      })),
      transaction: vi.fn(async (callback: (tx: typeof mockTx) => Promise<void>) => {
        await callback(mockTx);
      }),
    },
  };
});
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  and: vi.fn((...conds: unknown[]) => ({ type: 'and', conds })),
  isNull: vi.fn((field: unknown) => ({ field, type: 'isNull' })),
  lte: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'lte' })),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: {},
}));
vi.mock('@pagespace/db/schema/subscriptions', () => ({
  subscriptions: {},
  stripeEvents: {},
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
      api: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
      auth: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

// Mock the prepaid-credit funding shell. The route's unit tests must NOT load the real
// billing module — it opens a pg pool and drives a query chain the mock db can't satisfy,
// which would turn every funding-relevant event into a 500. Funding correctness lives in
// packages/lib/src/billing/__tests__/credit-funding.test.ts; here we only assert the wiring.
const mockApplyStripeFunding = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/lib/billing/credit-funding', () => ({
  applyStripeFunding: mockApplyStripeFunding,
}));

// The receipt sender does its own I/O (Resend, optional Stripe payment-intent lookup)
// and is unit-tested in isolation at send-payment-receipt-email.test.ts; here we only
// assert the webhook calls it (or doesn't) with the right arguments.
const { mockSendSubscriptionReceiptEmail, mockSendTopupReceiptEmail } = vi.hoisted(() => ({
  mockSendSubscriptionReceiptEmail: vi.fn().mockResolvedValue(undefined),
  mockSendTopupReceiptEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/billing/send-payment-receipt-email', () => ({
  sendSubscriptionReceiptEmail: mockSendSubscriptionReceiptEmail,
  sendTopupReceiptEmail: mockSendTopupReceiptEmail,
}));

// Import after mocks
import { POST } from '../route';
import { loggers } from '@pagespace/lib/logging/logger-config';

// Helper to create mock Stripe event
const mockStripeEvent = (type: string, data: unknown) => ({
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
}) as Stripe.Event;

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
  metadata: Record<string, string>;
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
  metadata: overrides.metadata ?? {},
  object: 'checkout.session',
} as Stripe.Checkout.Session);

// Helper to create mock user
const mockUser = (overrides: Partial<{
  id: string;
  stripeCustomerId: string;
  name: string;
  email: string;
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  stripeCustomerId: overrides.stripeCustomerId ?? 'cus_123',
  name: overrides.name ?? 'Test User',
  email: overrides.email ?? 'test@example.com',
});

describe('POST /api/stripe/webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set required environment variable
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';

    // Setup default database responses
    mockSelectLimit.mockResolvedValue([mockUser()]);
    mockInsertValues.mockReturnValue({
      onConflictDoNothing: mockInsertOnConflictDoNothing.mockReturnValue({
        returning: mockInsertReturning,
      }),
    });
    // Default: the idempotency insert wins the race (fresh row) → event is processed.
    mockInsertReturning.mockResolvedValue([{ id: 'evt_test' }]);
    mockTxInsertValues.mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    });
    // update().set().where() is awaited directly (completion/error marks) and also
    // chains .returning() on the reclaim takeover path.
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
    mockUpdateReturning.mockResolvedValue([{ id: 'evt_test' }]);
    mockDeleteWhere.mockResolvedValue(undefined);
    mockApplyStripeFunding.mockResolvedValue(undefined);
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
    it('should return 200 for a true duplicate whose prior attempt finished', async () => {
      const event = mockStripeEvent('customer.subscription.created', mockSubscription());
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      // Conflict: onConflictDoNothing().returning() yields no row...
      mockInsertReturning.mockResolvedValueOnce([]);
      // ...and the existing row shows the prior attempt already finished (processedAt set).
      mockSelectLimit.mockResolvedValueOnce([{ processedAt: new Date('2026-06-09T00:00:00Z') }]);

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

    it('should return 500 (retry) for a duplicate whose prior attempt is still in flight (within lease)', async () => {
      const event = mockStripeEvent('invoice.paid', mockInvoice());
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      // Redelivery raced an in-flight first attempt: conflict, processedAt null, claimed
      // just now (well within the lease) → genuinely in flight → retry, NOT a takeover.
      mockInsertReturning.mockResolvedValueOnce([]);
      mockSelectLimit.mockResolvedValueOnce([{ processedAt: null, createdAt: new Date() }]);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      // Must NOT ack — funding hasn't been applied yet. 500 forces Stripe to redeliver.
      expect(response.status).toBe(500);
      // The funding handler must not run on a retry signal, and we must not take over a live marker.
      expect(mockApplyStripeFunding).not.toHaveBeenCalled();
      expect(mockUpdateReturning).not.toHaveBeenCalled();
    });

    it('reclaims an abandoned marker (claim older than the lease) and reprocesses → 200', async () => {
      const event = mockStripeEvent('invoice.paid', mockInvoice());
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      // Conflict, processedAt still null, but claimed 20 minutes ago (worker died mid-flight).
      mockInsertReturning.mockResolvedValueOnce([]);
      const staleClaim = new Date(Date.now() - 20 * 60 * 1000);
      mockSelectLimit.mockResolvedValueOnce([{ processedAt: null, createdAt: staleClaim }]);
      // Atomic takeover UPDATE wins (one row re-leased).
      mockUpdateReturning.mockResolvedValueOnce([{ id: event.id }]);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(200);
      // Takeover happened and the funding handler ran on reprocess.
      expect(mockUpdateReturning).toHaveBeenCalled();
      expect(mockApplyStripeFunding).toHaveBeenCalled();
    });

    it('returns 500 (retry) when the takeover loses the race to another delivery', async () => {
      const event = mockStripeEvent('invoice.paid', mockInvoice());
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      mockInsertReturning.mockResolvedValueOnce([]);
      const staleClaim = new Date(Date.now() - 20 * 60 * 1000);
      mockSelectLimit.mockResolvedValueOnce([{ processedAt: null, createdAt: staleClaim }]);
      // Another concurrent delivery already re-leased the marker → our guarded UPDATE matches 0 rows.
      mockUpdateReturning.mockResolvedValueOnce([]);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(500);
      expect(mockApplyStripeFunding).not.toHaveBeenCalled();
    });

    it('should return 500 (retry) on a transient insert DB error — never silently ack', async () => {
      const event = mockStripeEvent('invoice.paid', mockInvoice());
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      // A pool timeout / dropped connection must NOT be treated as "already processed".
      mockInsertReturning.mockRejectedValueOnce(new Error('pool timeout'));

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'stripe-signature': 'valid_signature',
        },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(500);
      expect(mockApplyStripeFunding).not.toHaveBeenCalled();
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

    it('should set gifted=true when subscription has gift_subscription metadata', async () => {
      const subscription = {
        ...mockSubscription({ priceAmount: 1500 }),
        metadata: { type: 'gift_subscription', giftedBy: 'admin_123', reason: 'Test gift' },
      };
      const event = mockStripeEvent('customer.subscription.created', subscription);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      await POST(request);

      expect(mockTxInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ gifted: true })
      );
    });

    it('should set gifted=false for regular (non-gift) subscriptions', async () => {
      const subscription = mockSubscription({ priceAmount: 1500 });
      const event = mockStripeEvent('customer.subscription.created', subscription);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      await POST(request);

      expect(mockTxInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ gifted: false })
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

    it('funds the monthly credit bucket on invoice.paid (passing a tier option)', async () => {
      const event = mockStripeEvent('invoice.paid', mockInvoice({ amountPaid: 1500 }));
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockApplyStripeFunding).toHaveBeenCalledTimes(1);
      // Tier is derived from the invoice line; the bare mock invoice has no lines, so the
      // option is undefined and the funding shell falls back to the stored user tier.
      expect(mockApplyStripeFunding).toHaveBeenCalledWith(event, { tier: undefined });
    });

    it('returns 500 (retryable) when funding throws on invoice.paid', async () => {
      mockApplyStripeFunding.mockRejectedValueOnce(new Error('db boom'));
      const event = mockStripeEvent('invoice.paid', mockInvoice());
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      // withFundingRetry rethrows so the route 500s and Stripe redelivers.
      expect(response.status).toBe(500);
    });

    it('sends a payment receipt on invoice.paid', async () => {
      const invoice = mockInvoice({ amountPaid: 1500 });
      const event = mockStripeEvent('invoice.paid', invoice);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockSendSubscriptionReceiptEmail).toHaveBeenCalledTimes(1);
      expect(mockSendSubscriptionReceiptEmail).toHaveBeenCalledWith({
        invoice,
        email: 'test@example.com',
        userName: 'Test User',
        eventId: event.id,
      });
    });

    it('does not send a receipt for a $0 invoice (proration/trial)', async () => {
      const event = mockStripeEvent('invoice.paid', mockInvoice({ amountPaid: 0 }));
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockSendSubscriptionReceiptEmail).not.toHaveBeenCalled();
    });

    it('does not send a receipt when no user is found for the customer', async () => {
      mockSelectLimit.mockResolvedValue([]);
      const event = mockStripeEvent('invoice.paid', mockInvoice({ amountPaid: 1500 }));
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockSendSubscriptionReceiptEmail).not.toHaveBeenCalled();
    });

    it('still acks 200 (funding already committed) when the refilled-user lookup for the receipt throws', async () => {
      // First select is handleInvoicePaid's own user lookup (inside withFundingRetry);
      // second is the post-funding refilled-user lookup that feeds the receipt send.
      mockSelectLimit
        .mockResolvedValueOnce([mockUser()])
        .mockRejectedValueOnce(new Error('pool timeout'));
      const event = mockStripeEvent('invoice.paid', mockInvoice({ amountPaid: 1500 }));
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      // A failure in the post-commit receipt lookup must NOT escape to the outer
      // catch: that would mark the event processedAt/error and make a Stripe
      // redelivery classify as duplicate-ack, permanently skipping the receipt even
      // though funding already succeeded.
      expect(response.status).toBe(200);
      expect(mockSendSubscriptionReceiptEmail).not.toHaveBeenCalled();
      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Could not look up refilled user for subscription receipt',
        expect.objectContaining({ eventId: event.id }),
      );
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

    it('masks customer email in "Linked Stripe customer to user" log', async () => {
      const session = mockCheckoutSession({
        mode: 'subscription',
        customer: 'cus_new123',
        customerEmail: 'jane@example.com',
      });
      const event = mockStripeEvent('checkout.session.completed', session);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      await POST(request);

      const call = vi.mocked(loggers.api.info).mock.calls.find(
        c => c[0] === 'Linked Stripe customer to user'
      );
      expect(call).toBeDefined();
      const meta = call?.[1] as { email?: string };
      expect(meta.email).toBe('ja***@example.com');
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
          stripeCustomerId: 'cus_123',
        })
      );
    });

    it('routes checkout.session.completed through credit funding (top-up bucket)', async () => {
      const session = mockCheckoutSession({
        mode: 'payment',
        metadata: { kind: 'credit_pack', packCents: '2500', userId: 'user_123' },
      });
      const event = mockStripeEvent('checkout.session.completed', session);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockApplyStripeFunding).toHaveBeenCalledTimes(1);
      expect(mockApplyStripeFunding).toHaveBeenCalledWith(event);
    });

    it('sends a payment receipt on a credit-pack checkout, resolving the pack label', async () => {
      const session = mockCheckoutSession({
        mode: 'payment',
        customerEmail: 'buyer@example.com',
        metadata: { kind: 'credit_pack', packId: 'pack_25', packCents: '2500', userId: 'user_123' },
      });
      const event = mockStripeEvent('checkout.session.completed', session);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockSendTopupReceiptEmail).toHaveBeenCalledTimes(1);
      expect(mockSendTopupReceiptEmail).toHaveBeenCalledWith({
        session,
        packLabel: '$25 credits',
        email: 'buyer@example.com',
        userName: 'Test User',
        eventId: event.id,
      });
    });

    it('falls back to a generic pack label for an unresolvable/custom packId', async () => {
      const session = mockCheckoutSession({
        mode: 'payment',
        metadata: { kind: 'credit_pack', packId: 'custom', packCents: '1234', userId: 'user_123' },
      });
      const event = mockStripeEvent('checkout.session.completed', session);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      await POST(request);

      expect(mockSendTopupReceiptEmail).toHaveBeenCalledWith(
        expect.objectContaining({ packLabel: 'Credit top-up' }),
      );
    });

    it('does not send a receipt for a subscription-mode checkout session', async () => {
      const session = mockCheckoutSession({ mode: 'subscription' });
      const event = mockStripeEvent('checkout.session.completed', session);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      await POST(request);

      expect(mockSendTopupReceiptEmail).not.toHaveBeenCalled();
    });

    it('does not send a receipt when the checkout session has no buyer email', async () => {
      const session = mockCheckoutSession({
        mode: 'payment',
        metadata: { kind: 'credit_pack', packCents: '2500', userId: 'user_123' },
      });
      (session as { customer_details: unknown }).customer_details = null;
      const event = mockStripeEvent('checkout.session.completed', session);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockSendTopupReceiptEmail).not.toHaveBeenCalled();
    });

    it('still acks 200 (funding already committed) when the buyer lookup for the receipt throws', async () => {
      mockSelectLimit.mockRejectedValueOnce(new Error('pool timeout'));
      const session = mockCheckoutSession({
        mode: 'payment',
        customerEmail: 'buyer@example.com',
        metadata: { kind: 'credit_pack', packId: 'pack_25', packCents: '2500', userId: 'user_123' },
      });
      const event = mockStripeEvent('checkout.session.completed', session);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      // Same protection as the invoice.paid path: a failure in the post-commit
      // buyer lookup must not escape to the outer catch and mark the event
      // processed-with-error, or a Stripe redelivery would permanently skip the
      // receipt (duplicate-ack) even though funding already succeeded.
      expect(response.status).toBe(200);
      expect(mockSendTopupReceiptEmail).not.toHaveBeenCalled();
      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Could not look up buyer for top-up receipt',
        expect.objectContaining({ eventId: event.id }),
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

  describe('Control-Plane Provisioning Bridge', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        json: async () => ({ slug: 'acme', status: 'provisioning' }),
      });
      process.env.CONTROL_PLANE_URL = 'http://control-plane:4000';
      process.env.CONTROL_PLANE_API_KEY = 'test-api-key';
    });

    afterEach(() => {
      global.fetch = originalFetch;
      delete process.env.CONTROL_PLANE_URL;
      delete process.env.CONTROL_PLANE_API_KEY;
    });

    it('should call control-plane to provision tenant when metadata.slug is present', async () => {
      const session = mockCheckoutSession({
        mode: 'subscription',
        customer: 'cus_new123',
        customerEmail: 'admin@acme.com',
        metadata: { slug: 'acme', tier: 'business' },
      });
      const event = mockStripeEvent('checkout.session.completed', session);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://control-plane:4000/api/tenants',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-API-Key': 'test-api-key',
          }),
          body: JSON.stringify({
            slug: 'acme',
            name: 'acme',
            ownerEmail: 'admin@acme.com',
            tier: 'business',
          }),
        }),
      );
    });

    it('remaps a founder checkout to control-plane business instead of failing tenant-validation (#2148)', async () => {
      const session = mockCheckoutSession({
        mode: 'subscription',
        customer: 'cus_new123',
        customerEmail: 'admin@acme.com',
        metadata: { slug: 'acme', tier: 'founder' },
      });
      const event = mockStripeEvent('checkout.session.completed', session);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://control-plane:4000/api/tenants',
        expect.objectContaining({
          body: JSON.stringify({
            slug: 'acme',
            name: 'acme',
            ownerEmail: 'admin@acme.com',
            tier: 'business',
          }),
        }),
      );
    });

    it('forwards a control-plane-only tier (enterprise) UNCHANGED — it is not part of the SaaS vocabulary and must not be coerced to pro', async () => {
      const session = mockCheckoutSession({
        mode: 'subscription',
        customer: 'cus_new123',
        customerEmail: 'admin@acme.com',
        metadata: { slug: 'acme', tier: 'enterprise' },
      });
      const event = mockStripeEvent('checkout.session.completed', session);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://control-plane:4000/api/tenants',
        expect.objectContaining({
          body: JSON.stringify({
            slug: 'acme',
            name: 'acme',
            ownerEmail: 'admin@acme.com',
            tier: 'enterprise',
          }),
        }),
      );
    });

    it('should not call control-plane when metadata.slug is absent', async () => {
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
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should skip provisioning when CONTROL_PLANE_URL is not set', async () => {
      delete process.env.CONTROL_PLANE_URL;

      const session = mockCheckoutSession({
        mode: 'subscription',
        customer: 'cus_new123',
        customerEmail: 'admin@acme.com',
        metadata: { slug: 'acme', tier: 'business' },
      });
      const event = mockStripeEvent('checkout.session.completed', session);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should not throw when control-plane call fails', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Connection refused')
      );

      const session = mockCheckoutSession({
        mode: 'subscription',
        customer: 'cus_new123',
        customerEmail: 'admin@acme.com',
        metadata: { slug: 'acme', tier: 'business' },
      });
      const event = mockStripeEvent('checkout.session.completed', session);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      // Must still return 200 — fire-and-forget
      expect(response.status).toBe(200);
    });

    it('should default tier to pro when metadata.tier is absent', async () => {
      const session = mockCheckoutSession({
        mode: 'subscription',
        customer: 'cus_new123',
        customerEmail: 'admin@acme.com',
        metadata: { slug: 'acme' },
      });
      const event = mockStripeEvent('checkout.session.completed', session);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      await POST(request);

      expect(global.fetch).toHaveBeenCalledWith(
        'http://control-plane:4000/api/tenants',
        expect.objectContaining({
          body: JSON.stringify({
            slug: 'acme',
            name: 'acme',
            ownerEmail: 'admin@acme.com',
            tier: 'pro',
          }),
        }),
      );
    });

    it('should still return 200 when control-plane returns non-2xx', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: 'Tenant slug "acme" already exists' }),
      });

      const session = mockCheckoutSession({
        mode: 'subscription',
        customer: 'cus_new123',
        customerEmail: 'admin@acme.com',
        metadata: { slug: 'acme', tier: 'business' },
      });
      const event = mockStripeEvent('checkout.session.completed', session);
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const request = new Request('https://example.com/api/stripe/webhook', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 'valid_signature' },
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe('Event Processing', () => {
    it('should mark event as processed successfully', async () => {
      const frozenDate = new Date('2025-01-15T12:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(frozenDate);

      try {
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
            processedAt: frozenDate,
          })
        );
      } finally {
        vi.useRealTimers();
      }
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
