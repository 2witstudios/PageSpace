import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock Stripe - use vi.hoisted to ensure mocks are available before vi.mock
const {
  mockStripeSubscriptionsRetrieve,
  mockStripeSubscriptionsUpdate,
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
  mockUpdateWhere,
  mockUpdateSet,
  usersTable,
  subscriptionsTable,
} = vi.hoisted(() => ({
  mockUserQuery: vi.fn(),
  mockSubscriptionQuery: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockUpdateSet: vi.fn(),
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
}> = {}) => ({
  id: overrides.id ?? 'user_123',
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
  stripeSubscriptionId: 'stripeSubscriptionId' in overrides ? overrides.stripeSubscriptionId : 'sub_123',
  status: overrides.status ?? 'active',
});

describe('POST /api/stripe/cancel-subscription', () => {
  const mockUserId = 'user_123';
  const periodEndTimestamp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days from now

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
    // Retrieve returns subscription without schedule by default
    mockStripeSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_123',
      schedule: null,
    });
    mockStripeSubscriptionsUpdate.mockResolvedValue({
      id: 'sub_123',
      cancel_at_period_end: true,
      items: {
        data: [{
          current_period_end: periodEndTimestamp,
        }],
      },
    });
    mockStripeSubscriptionSchedulesRelease.mockResolvedValue({});
  });

  it('should cancel subscription at period end', async () => {
    const request = new Request('https://example.com/api/stripe/cancel-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.subscriptionId).toBe('sub_123');
    expect(body.cancelAtPeriodEnd).toBe(true);
    expect(body.currentPeriodEnd).toBeDefined();
    expect(body.message).toContain('cancelled at the end');
  });

  it('should update Stripe subscription with cancel_at_period_end', async () => {
    const request = new Request('https://example.com/api/stripe/cancel-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    await POST(request);

    expect(mockStripeSubscriptionsUpdate).toHaveBeenCalledWith(
      'sub_123',
      { cancel_at_period_end: true, expand: ['items'] }
    );
  });

  it('should update local database record', async () => {
    const request = new Request('https://example.com/api/stripe/cancel-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    await POST(request);

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        cancelAtPeriodEnd: true,
      })
    );
  });

  it('should return 404 when user not found', async () => {
    mockUserQuery.mockResolvedValue([]);

    const request = new Request('https://example.com/api/stripe/cancel-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('User not found');
  });

  it('should return 400 when no active subscription', async () => {
    mockUserQuery.mockResolvedValue([mockUser()]);
    mockSubscriptionQuery.mockResolvedValue([]); // No subscription

    const request = new Request('https://example.com/api/stripe/cancel-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('No active subscription found');
  });

  it('should return 400 when subscription has no stripeSubscriptionId', async () => {
    mockUserQuery.mockResolvedValue([mockUser()]);
    mockSubscriptionQuery.mockResolvedValue([mockDbSubscription({ stripeSubscriptionId: null })]);

    const request = new Request('https://example.com/api/stripe/cancel-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('No active subscription found');
  });

  it('should return 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

    const request = new Request('https://example.com/api/stripe/cancel-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it('should return correct period end date', async () => {
    const request = new Request('https://example.com/api/stripe/cancel-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const body = await response.json();

    const expectedDate = new Date(periodEndTimestamp * 1000).toISOString();
    expect(body.currentPeriodEnd).toBe(expectedDate);
  });
});
