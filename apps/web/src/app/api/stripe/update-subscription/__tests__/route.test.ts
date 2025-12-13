import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock Stripe - use vi.hoisted to ensure mocks are available before vi.mock
const {
  mockStripeSubscriptionsRetrieve,
  mockStripeSubscriptionsUpdate,
  mockStripeSubscriptionSchedulesCreate,
  mockStripeSubscriptionSchedulesRetrieve,
  mockStripeSubscriptionSchedulesUpdate,
  mockStripeSubscriptionSchedulesRelease,
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
    mockStripeSubscriptionSchedulesCreate: vi.fn(),
    mockStripeSubscriptionSchedulesRetrieve: vi.fn(),
    mockStripeSubscriptionSchedulesUpdate: vi.fn(),
    mockStripeSubscriptionSchedulesRelease: vi.fn(),
    StripeError,
  };
});

vi.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: {
      retrieve: mockStripeSubscriptionsRetrieve,
      update: mockStripeSubscriptionsUpdate,
    },
    subscriptionSchedules: {
      create: mockStripeSubscriptionSchedulesCreate,
      retrieve: mockStripeSubscriptionSchedulesRetrieve,
      update: mockStripeSubscriptionSchedulesUpdate,
      release: mockStripeSubscriptionSchedulesRelease,
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
  mockUpdateSet,
  mockUpdateWhere,
  usersTable,
  subscriptionsTable,
} = vi.hoisted(() => ({
  mockUserQuery: vi.fn(),
  mockSubscriptionQuery: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
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
      update: vi.fn(() => ({
        set: mockUpdateSet.mockReturnValue({
          where: mockUpdateWhere,
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
  stripeCustomerId: 'stripeCustomerId' in overrides ? overrides.stripeCustomerId : 'cus_123',
  subscriptionTier: overrides.subscriptionTier ?? 'pro',
});

// Helper to create mock subscription (from database)
const mockDbSubscription = (overrides: Partial<{
  id: string;
  userId: string;
  stripeSubscriptionId: string | null;
  status: string;
}> = {}) => ({
  id: overrides.id ?? 'local_sub_123',
  userId: overrides.userId ?? 'user_123',
  stripeSubscriptionId: overrides.stripeSubscriptionId ?? 'sub_123',
  status: overrides.status ?? 'active',
});

// Helper to create mock Stripe subscription
const mockStripeSubscription = (overrides: Partial<{
  id: string;
  status: string;
  schedule: string | null;
  items: { data: Array<{ id: string; price: { id: string }; current_period_end: number }> };
}> = {}) => ({
  id: overrides.id ?? 'sub_123',
  status: overrides.status ?? 'active',
  schedule: overrides.schedule ?? null,
  items: overrides.items ?? {
    data: [{
      id: 'si_123',
      price: { id: 'price_pro' },
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days from now
    }],
  },
});

describe('POST /api/stripe/update-subscription', () => {
  const mockUserId = 'user_123';
  const mockPriceId = 'price_founder_monthly';

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Setup default database responses
    mockUserQuery.mockResolvedValue([mockUser()]);
    mockSubscriptionQuery.mockResolvedValue([mockDbSubscription()]);
    mockUpdateWhere.mockResolvedValue(undefined);
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });

    // Setup default Stripe mocks
    mockStripeSubscriptionsRetrieve.mockResolvedValue(mockStripeSubscription());
    mockStripeSubscriptionsUpdate.mockResolvedValue(mockStripeSubscription());
    mockStripeSubscriptionSchedulesCreate.mockResolvedValue({
      id: 'sch_123',
      phases: [{ start_date: Math.floor(Date.now() / 1000) }],
    });
    mockStripeSubscriptionSchedulesUpdate.mockResolvedValue({
      id: 'sch_123',
    });
    mockStripeSubscriptionSchedulesRelease.mockResolvedValue({});
  });

  describe('Upgrade flow (immediate)', () => {
    it('should upgrade subscription immediately with proration', async () => {
      const request = new Request('https://example.com/api/stripe/update-subscription', {
        method: 'POST',
        body: JSON.stringify({ priceId: mockPriceId, isDowngrade: false }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.subscriptionId).toBe('sub_123');
      expect(body.message).toBe('Plan upgraded successfully');
    });

    it('should update subscription with proration behavior', async () => {
      const request = new Request('https://example.com/api/stripe/update-subscription', {
        method: 'POST',
        body: JSON.stringify({ priceId: mockPriceId }),
      });

      await POST(request);

      expect(mockStripeSubscriptionsUpdate).toHaveBeenCalledWith(
        'sub_123',
        {
          items: [{
            id: 'si_123',
            price: mockPriceId,
          }],
          proration_behavior: 'always_invoice',
        }
      );
    });
  });

  describe('Downgrade flow (scheduled)', () => {
    it('should schedule downgrade at period end', async () => {
      const request = new Request('https://example.com/api/stripe/update-subscription', {
        method: 'POST',
        body: JSON.stringify({ priceId: mockPriceId, isDowngrade: true }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.status).toBe('scheduled');
      expect(body.scheduleId).toBe('sch_123');
      expect(body.message).toBe('Plan change scheduled for next billing period');
      expect(body.effectiveDate).toBeDefined();
    });

    it('should create subscription schedule for downgrade', async () => {
      const request = new Request('https://example.com/api/stripe/update-subscription', {
        method: 'POST',
        body: JSON.stringify({ priceId: mockPriceId, isDowngrade: true }),
      });

      await POST(request);

      expect(mockStripeSubscriptionSchedulesCreate).toHaveBeenCalledWith({
        from_subscription: 'sub_123',
      });
    });

    it('should use existing schedule if available', async () => {
      mockStripeSubscriptionsRetrieve.mockResolvedValue(
        mockStripeSubscription({ schedule: 'sch_existing' })
      );
      mockStripeSubscriptionSchedulesRetrieve.mockResolvedValue({
        id: 'sch_existing',
        phases: [{ start_date: Math.floor(Date.now() / 1000) }],
      });

      const request = new Request('https://example.com/api/stripe/update-subscription', {
        method: 'POST',
        body: JSON.stringify({ priceId: mockPriceId, isDowngrade: true }),
      });

      await POST(request);

      expect(mockStripeSubscriptionSchedulesRetrieve).toHaveBeenCalledWith('sch_existing');
      expect(mockStripeSubscriptionSchedulesCreate).not.toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should return 400 when priceId is missing', async () => {
      const request = new Request('https://example.com/api/stripe/update-subscription', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Price ID is required');
    });

    it('should return 404 when user not found', async () => {
      mockUserQuery.mockResolvedValue([]);

      const request = new Request('https://example.com/api/stripe/update-subscription', {
        method: 'POST',
        body: JSON.stringify({ priceId: mockPriceId }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should return 400 when no Stripe customer', async () => {
      mockUserQuery.mockResolvedValue([mockUser({ stripeCustomerId: null })]);

      const request = new Request('https://example.com/api/stripe/update-subscription', {
        method: 'POST',
        body: JSON.stringify({ priceId: mockPriceId }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('No Stripe customer found');
    });

    it('should return 400 when no active subscription', async () => {
      mockUserQuery.mockResolvedValue([mockUser()]);
      mockSubscriptionQuery.mockResolvedValue([]); // No subscription

      const request = new Request('https://example.com/api/stripe/update-subscription', {
        method: 'POST',
        body: JSON.stringify({ priceId: mockPriceId }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('No active subscription found');
    });

    it('should return 400 when subscription is not active or trialing', async () => {
      mockStripeSubscriptionsRetrieve.mockResolvedValue(
        mockStripeSubscription({ status: 'canceled' })
      );

      const request = new Request('https://example.com/api/stripe/update-subscription', {
        method: 'POST',
        body: JSON.stringify({ priceId: mockPriceId }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Subscription is not active');
    });

    it('should return 400 when no subscription items found', async () => {
      mockStripeSubscriptionsRetrieve.mockResolvedValue(
        mockStripeSubscription({ items: { data: [] } })
      );

      const request = new Request('https://example.com/api/stripe/update-subscription', {
        method: 'POST',
        body: JSON.stringify({ priceId: mockPriceId }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('No subscription items found');
    });

    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/stripe/update-subscription', {
        method: 'POST',
        body: JSON.stringify({ priceId: mockPriceId }),
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
    });
  });

  describe('Business rules', () => {
    it('should default isDowngrade to false', async () => {
      const request = new Request('https://example.com/api/stripe/update-subscription', {
        method: 'POST',
        body: JSON.stringify({ priceId: mockPriceId }), // No isDowngrade
      });

      await POST(request);

      // Should use update (upgrade path), not schedules
      expect(mockStripeSubscriptionsUpdate).toHaveBeenCalled();
      expect(mockStripeSubscriptionSchedulesCreate).not.toHaveBeenCalled();
    });

    it('should fetch subscription with expanded items', async () => {
      const request = new Request('https://example.com/api/stripe/update-subscription', {
        method: 'POST',
        body: JSON.stringify({ priceId: mockPriceId }),
      });

      await POST(request);

      expect(mockStripeSubscriptionsRetrieve).toHaveBeenCalledWith(
        'sub_123',
        { expand: ['items'] }
      );
    });

    it('should allow upgrade when subscription is trialing', async () => {
      mockStripeSubscriptionsRetrieve.mockResolvedValue(
        mockStripeSubscription({ status: 'trialing' })
      );

      const request = new Request('https://example.com/api/stripe/update-subscription', {
        method: 'POST',
        body: JSON.stringify({ priceId: mockPriceId }),
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });
});
