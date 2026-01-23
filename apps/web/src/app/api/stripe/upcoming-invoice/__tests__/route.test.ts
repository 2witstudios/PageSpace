import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock Stripe - use vi.hoisted to ensure mocks are available before vi.mock
const {
  mockStripeInvoicesCreatePreview,
  mockStripeSubscriptionsRetrieve,
  StripeError,
} = vi.hoisted(() => {
  const StripeError = class extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.name = 'StripeError';
      this.code = code;
    }
  };
  return {
    mockStripeInvoicesCreatePreview: vi.fn(),
    mockStripeSubscriptionsRetrieve: vi.fn(),
    StripeError,
  };
});

vi.mock('@/lib/stripe', () => ({
  stripe: {
    invoices: {
      createPreview: mockStripeInvoicesCreatePreview,
    },
    subscriptions: {
      retrieve: mockStripeSubscriptionsRetrieve,
    },
  },
  Stripe: {
    errors: { StripeError },
  },
}));

// Mock database - use vi.hoisted for variables used in vi.mock
const {
  mockUserQuery,
  mockSubscriptionQuery,
  usersTable,
  subscriptionsTable,
} = vi.hoisted(() => ({
  mockUserQuery: vi.fn(),
  mockSubscriptionQuery: vi.fn(),
  usersTable: Symbol('users'),
  subscriptionsTable: Symbol('subscriptions'),
}));

vi.mock('@pagespace/db', () => {
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn((table: symbol) => {
          if (table === usersTable) {
            return { where: mockUserQuery };
          }
          return {
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: mockSubscriptionQuery,
              })),
            })),
          };
        }),
      })),
    },
    users: usersTable,
    subscriptions: subscriptionsTable,
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
    and: vi.fn((...args: unknown[]) => ({ args, type: 'and' })),
    inArray: vi.fn((field: unknown, values: unknown) => ({ field, values, type: 'inArray' })),
    desc: vi.fn((field: unknown) => ({ field, type: 'desc' })),
  };
});

// Mock auth
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Import after mocks
import { GET } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// Helper to create mock SessionAuthResult
const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock user
const mockUser = (overrides: Partial<{
  id: string;
  stripeCustomerId: string | null;
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  stripeCustomerId: 'stripeCustomerId' in overrides ? overrides.stripeCustomerId : 'cus_123',
});

// Helper to create mock subscription
const mockSubscription = (overrides: Partial<{
  userId: string;
  stripeSubscriptionId: string | null;
  status: string;
}> = {}) => ({
  userId: overrides.userId ?? 'user_123',
  stripeSubscriptionId: 'stripeSubscriptionId' in overrides ? overrides.stripeSubscriptionId : 'sub_123',
  status: overrides.status ?? 'active',
});

// Helper to create mock Stripe subscription (from Stripe API)
const mockStripeSubscription = (overrides: Partial<{
  id: string;
  itemId: string;
}> = {}) => ({
  id: overrides.id ?? 'sub_123',
  items: {
    data: [{
      id: overrides.itemId ?? 'si_123',
      price: { id: 'price_123' },
    }],
  },
});

// Helper to create mock invoice line item
const mockLineItem = (overrides: Partial<{
  description: string | null;
  amount: number;
  proration: boolean;
  period_start: number;
  period_end: number;
}> = {}) => ({
  description: overrides.description ?? 'Pro Plan Subscription',
  amount: overrides.amount ?? 1500,
  proration: overrides.proration ?? false,
  period: {
    start: overrides.period_start ?? 1700000000,
    end: overrides.period_end ?? 1702592000,
  },
});

// Helper to create mock invoice preview
const mockInvoicePreview = (overrides: Partial<{
  amount_due: number;
  subtotal: number;
  total: number;
  currency: string;
  period_start: number | null;
  period_end: number | null;
  next_payment_attempt: number | null;
  lines: ReturnType<typeof mockLineItem>[];
}> = {}) => ({
  amount_due: overrides.amount_due ?? 1500,
  subtotal: overrides.subtotal ?? 1500,
  total: overrides.total ?? 1500,
  currency: overrides.currency ?? 'usd',
  period_start: 'period_start' in overrides ? overrides.period_start : 1700000000,
  period_end: 'period_end' in overrides ? overrides.period_end : 1702592000,
  next_payment_attempt: 'next_payment_attempt' in overrides ? overrides.next_payment_attempt : 1702592000,
  lines: {
    data: overrides.lines ?? [mockLineItem()],
  },
});

describe('Upcoming Invoice API', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Setup default database responses
    mockUserQuery.mockResolvedValue([mockUser()]);
    mockSubscriptionQuery.mockResolvedValue([mockSubscription()]);

    // Setup default Stripe mocks
    mockStripeInvoicesCreatePreview.mockResolvedValue(mockInvoicePreview());
    mockStripeSubscriptionsRetrieve.mockResolvedValue(mockStripeSubscription());
  });

  describe('GET /api/stripe/upcoming-invoice', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/stripe/upcoming-invoice', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should return 404 when user not found', async () => {
      mockUserQuery.mockResolvedValue([]);

      const request = new Request('https://example.com/api/stripe/upcoming-invoice', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should return null invoice when user has no Stripe customer', async () => {
      mockUserQuery.mockResolvedValue([mockUser({ stripeCustomerId: null })]);

      const request = new Request('https://example.com/api/stripe/upcoming-invoice', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.invoice).toBeNull();
      expect(body.message).toBe('No customer found');
    });

    it('should return null invoice when user has no subscription', async () => {
      mockUserQuery.mockResolvedValue([mockUser()]);
      mockSubscriptionQuery.mockResolvedValue([]); // No subscription

      const request = new Request('https://example.com/api/stripe/upcoming-invoice', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.invoice).toBeNull();
      expect(body.message).toBe('No active subscription');
    });

    it('should return null invoice when subscription has no Stripe ID', async () => {
      mockUserQuery.mockResolvedValue([mockUser()]);
      mockSubscriptionQuery.mockResolvedValue([mockSubscription({ stripeSubscriptionId: null })]);

      const request = new Request('https://example.com/api/stripe/upcoming-invoice', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.invoice).toBeNull();
      expect(body.message).toBe('No active subscription');
    });

    it('should return invoice preview successfully', async () => {
      const request = new Request('https://example.com/api/stripe/upcoming-invoice', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.invoice).toMatchObject({
        amountDue: 1500,
        subtotal: 1500,
        total: 1500,
        currency: 'usd',
        periodStart: expect.any(String),
        periodEnd: expect.any(String),
        nextPaymentAttempt: expect.any(String),
      });
      expect(body.invoice.lines).toHaveLength(1);
      expect(body.proration).toBeNull();
    });

    it('should call Stripe with customer and subscription', async () => {
      const request = new Request('https://example.com/api/stripe/upcoming-invoice', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      await GET(request);

      expect(mockStripeInvoicesCreatePreview).toHaveBeenCalledWith({
        customer: 'cus_123',
        subscription: 'sub_123',
      });
    });

    it('should include plan change preview when priceId provided', async () => {
      const request = new Request('https://example.com/api/stripe/upcoming-invoice?priceId=price_new', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      await GET(request);

      expect(mockStripeSubscriptionsRetrieve).toHaveBeenCalledWith('sub_123');
      expect(mockStripeInvoicesCreatePreview).toHaveBeenCalledWith({
        customer: 'cus_123',
        subscription: 'sub_123',
        subscription_details: {
          items: [{
            id: 'si_123',
            price: 'price_new',
          }],
          proration_behavior: 'create_prorations',
        },
      });
    });

    it('should calculate proration amounts when simulating plan change', async () => {
      mockStripeInvoicesCreatePreview.mockResolvedValue(mockInvoicePreview({
        lines: [
          mockLineItem({ description: 'Unused Pro', amount: -500, proration: true }),
          mockLineItem({ description: 'Business remainder', amount: 1000, proration: true }),
          mockLineItem({ description: 'Business Plan', amount: 2500, proration: false }),
        ],
      }));

      const request = new Request('https://example.com/api/stripe/upcoming-invoice?priceId=price_business', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(body.proration).toEqual({
        amount: 500, // -500 + 1000
        items: [
          { description: 'Unused Pro', amount: -500 },
          { description: 'Business remainder', amount: 1000 },
        ],
      });
    });

    it('should handle null period dates', async () => {
      mockStripeInvoicesCreatePreview.mockResolvedValue(mockInvoicePreview({
        period_start: null,
        period_end: null,
        next_payment_attempt: null,
      }));

      const request = new Request('https://example.com/api/stripe/upcoming-invoice', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(body.invoice.periodStart).toBeNull();
      expect(body.invoice.periodEnd).toBeNull();
      expect(body.invoice.nextPaymentAttempt).toBeNull();
    });

    it('should handle invoice_upcoming_none error gracefully', async () => {
      const error = new StripeError('No upcoming invoices', 'invoice_upcoming_none');
      mockStripeInvoicesCreatePreview.mockRejectedValue(error);

      const request = new Request('https://example.com/api/stripe/upcoming-invoice', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.invoice).toBeNull();
      expect(body.message).toBe('No upcoming invoice');
    });

    it('should return 400 on other Stripe errors', async () => {
      const error = new StripeError('Invalid subscription');
      mockStripeInvoicesCreatePreview.mockRejectedValue(error);

      const request = new Request('https://example.com/api/stripe/upcoming-invoice', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid subscription');
    });

    it('should return 500 on generic errors', async () => {
      mockStripeInvoicesCreatePreview.mockRejectedValue(new Error('Network error'));

      const request = new Request('https://example.com/api/stripe/upcoming-invoice', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch upcoming invoice');
    });
  });
});
