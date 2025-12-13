import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Helper to create mock NextRequest for testing
const createMockRequest = (url: string, init?: RequestInit): NextRequest => {
  return new Request(url, init) as unknown as NextRequest;
};

// Mock database
const mockDbSelect = vi.fn();
vi.mock('@pagespace/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: mockDbSelect,
      }),
    }),
  },
  eq: vi.fn((a, b) => ({ a, b })),
  users: { id: 'id' },
}));

// Mock Stripe - use vi.hoisted to ensure mocks are available before vi.mock
const {
  mockStripeSubscriptionsRetrieve,
  mockStripeSubscriptionsUpdate,
  mockStripeInvoicesRetrieve,
  StripeError,
} = vi.hoisted(() => {
  const StripeError = class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'StripeError';
    }
  };
  return {
    mockStripeSubscriptionsRetrieve: vi.fn(),
    mockStripeSubscriptionsUpdate: vi.fn(),
    mockStripeInvoicesRetrieve: vi.fn(),
    StripeError,
  };
});

vi.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: {
      retrieve: mockStripeSubscriptionsRetrieve,
      update: mockStripeSubscriptionsUpdate,
    },
    invoices: {
      retrieve: mockStripeInvoicesRetrieve,
    },
  },
  Stripe: {
    errors: { StripeError },
  },
}));

// Mock auth
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Mock loggers
vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
    },
  },
}));

// Import after mocks
import { POST } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string): WebAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'jwt',
  source: 'cookie',
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
  subscriptionTier: string;
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  stripeCustomerId: overrides.stripeCustomerId ?? 'cus_123',
  subscriptionTier: overrides.subscriptionTier ?? 'free',
});

// Helper to create mock subscription
const mockSubscription = (overrides: Partial<{
  id: string;
  status: string;
  metadata: { userId?: string };
  latest_invoice: string;
}> = {}) => ({
  id: overrides.id ?? 'sub_123',
  status: overrides.status ?? 'incomplete',
  metadata: overrides.metadata ?? { userId: 'user_123' },
  latest_invoice: overrides.latest_invoice ?? 'in_123',
});

// Helper to create mock invoice
const mockInvoice = (overrides: Partial<{
  id: string;
  amount_due: number;
  discounts: Array<{ coupon: { id: string; percent_off: number | null; amount_off: number | null } }>;
}> = {}) => ({
  id: overrides.id ?? 'in_123',
  amount_due: overrides.amount_due ?? 1600, // $16.00 (after discount)
  discounts: overrides.discounts ?? [{
    coupon: {
      id: 'coupon_123',
      percent_off: 20,
      amount_off: null,
    },
  }],
});

describe('POST /api/stripe/apply-promo', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Setup default database mock
    mockDbSelect.mockResolvedValue([mockUser()]);

    // Setup default Stripe mocks
    mockStripeSubscriptionsRetrieve.mockResolvedValue(mockSubscription());
    mockStripeSubscriptionsUpdate.mockResolvedValue(mockSubscription());
    mockStripeInvoicesRetrieve.mockResolvedValue(mockInvoice());
  });

  describe('Success cases', () => {
    it('should apply promo code to incomplete subscription', async () => {
      const request = createMockRequest('https://example.com/api/stripe/apply-promo', {
        method: 'POST',
        body: JSON.stringify({
          subscriptionId: 'sub_123',
          promotionCodeId: 'promo_123',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.subscriptionId).toBe('sub_123');
      expect(body.amountDue).toBe(1600);
      expect(body.discount).toEqual({
        couponId: 'coupon_123',
        percentOff: 20,
        amountOff: null,
      });
    });

    it('should call Stripe subscriptions.update with discounts array', async () => {
      const request = createMockRequest('https://example.com/api/stripe/apply-promo', {
        method: 'POST',
        body: JSON.stringify({
          subscriptionId: 'sub_456',
          promotionCodeId: 'promo_789',
        }),
      });

      await POST(request);

      expect(mockStripeSubscriptionsUpdate).toHaveBeenCalledWith('sub_456', {
        discounts: [{ promotion_code: 'promo_789' }],
      });
    });

    it('should return null discount when invoice has no discounts', async () => {
      mockStripeInvoicesRetrieve.mockResolvedValue({
        id: 'in_123',
        amount_due: 2000,
        discounts: [],
      });

      const request = createMockRequest('https://example.com/api/stripe/apply-promo', {
        method: 'POST',
        body: JSON.stringify({
          subscriptionId: 'sub_123',
          promotionCodeId: 'promo_123',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.discount).toBe(null);
    });
  });

  describe('Validation errors', () => {
    it('should return 400 when subscriptionId is missing', async () => {
      const request = createMockRequest('https://example.com/api/stripe/apply-promo', {
        method: 'POST',
        body: JSON.stringify({ promotionCodeId: 'promo_123' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Subscription ID and promotion code ID are required');
    });

    it('should return 400 when promotionCodeId is missing', async () => {
      const request = createMockRequest('https://example.com/api/stripe/apply-promo', {
        method: 'POST',
        body: JSON.stringify({ subscriptionId: 'sub_123' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Subscription ID and promotion code ID are required');
    });

    it('should return 404 when user is not found', async () => {
      mockDbSelect.mockResolvedValue([]);

      const request = createMockRequest('https://example.com/api/stripe/apply-promo', {
        method: 'POST',
        body: JSON.stringify({
          subscriptionId: 'sub_123',
          promotionCodeId: 'promo_123',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should return 404 when subscription does not belong to user', async () => {
      mockStripeSubscriptionsRetrieve.mockResolvedValue(
        mockSubscription({ metadata: { userId: 'other_user' } })
      );

      const request = createMockRequest('https://example.com/api/stripe/apply-promo', {
        method: 'POST',
        body: JSON.stringify({
          subscriptionId: 'sub_123',
          promotionCodeId: 'promo_123',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Subscription not found');
    });

    it('should return 400 when subscription is not incomplete', async () => {
      mockStripeSubscriptionsRetrieve.mockResolvedValue(
        mockSubscription({ status: 'active' })
      );

      const request = createMockRequest('https://example.com/api/stripe/apply-promo', {
        method: 'POST',
        body: JSON.stringify({
          subscriptionId: 'sub_123',
          promotionCodeId: 'promo_123',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Promotion codes can only be applied to pending subscriptions');
    });
  });

  describe('Error handling', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createMockRequest('https://example.com/api/stripe/apply-promo', {
        method: 'POST',
        body: JSON.stringify({
          subscriptionId: 'sub_123',
          promotionCodeId: 'promo_123',
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should return 400 on Stripe API error', async () => {
      mockStripeSubscriptionsUpdate.mockRejectedValue(
        new StripeError('Invalid promotion code')
      );

      const request = createMockRequest('https://example.com/api/stripe/apply-promo', {
        method: 'POST',
        body: JSON.stringify({
          subscriptionId: 'sub_123',
          promotionCodeId: 'promo_invalid',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid promotion code');
    });

    it('should return 500 on unexpected error', async () => {
      mockStripeSubscriptionsUpdate.mockRejectedValue(new Error('Network error'));

      const request = createMockRequest('https://example.com/api/stripe/apply-promo', {
        method: 'POST',
        body: JSON.stringify({
          subscriptionId: 'sub_123',
          promotionCodeId: 'promo_123',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to apply promotion code');
    });
  });
});
