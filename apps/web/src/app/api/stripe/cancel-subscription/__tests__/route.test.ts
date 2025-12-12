import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock Stripe - use vi.hoisted to ensure mocks are available before vi.mock
const { mockStripeSubscriptionsUpdate, StripeError } = vi.hoisted(() => {
  const StripeError = class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'StripeError';
    }
  };
  return {
    mockStripeSubscriptionsUpdate: vi.fn(),
    StripeError,
  };
});

vi.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: {
      update: mockStripeSubscriptionsUpdate,
    },
  },
  Stripe: {
    errors: { StripeError },
  },
}));

// Mock database
const mockSelectWhere = vi.fn();
const mockUpdateWhere = vi.fn();
const mockUpdateSet = vi.fn();

vi.mock('@pagespace/db', () => {
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: mockSelectWhere,
        })),
      })),
      update: vi.fn(() => ({
        set: mockUpdateSet.mockReturnValue({
          where: mockUpdateWhere,
        }),
      })),
    },
    users: {},
    subscriptions: {},
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
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
}> = {}) => ({
  id: overrides.id ?? 'local_sub_123',
  userId: overrides.userId ?? 'user_123',
  stripeSubscriptionId: 'stripeSubscriptionId' in overrides ? overrides.stripeSubscriptionId : 'sub_123',
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
    let selectCallCount = 0;
    mockSelectWhere.mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return Promise.resolve([mockUser()]);
      }
      return Promise.resolve([mockDbSubscription()]);
    });

    mockUpdateWhere.mockResolvedValue(undefined);
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });

    // Setup default Stripe mock
    mockStripeSubscriptionsUpdate.mockResolvedValue({
      id: 'sub_123',
      cancel_at_period_end: true,
      items: {
        data: [{
          current_period_end: periodEndTimestamp,
        }],
      },
    });
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
    mockSelectWhere.mockResolvedValue([]);

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
    let selectCallCount = 0;
    mockSelectWhere.mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return Promise.resolve([mockUser()]);
      }
      return Promise.resolve([]); // No subscription
    });

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
    let selectCallCount = 0;
    mockSelectWhere.mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return Promise.resolve([mockUser()]);
      }
      return Promise.resolve([mockDbSubscription({ stripeSubscriptionId: null })]);
    });

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
