import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock Stripe - use vi.hoisted to ensure mocks are available before vi.mock
const { mockStripeSubscriptionsRetrieve, mockStripeSubscriptionsUpdate, StripeError } = vi.hoisted(() => {
  const StripeError = class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'StripeError';
    }
  };
  return {
    mockStripeSubscriptionsRetrieve: vi.fn(),
    mockStripeSubscriptionsUpdate: vi.fn(),
    StripeError,
  };
});

vi.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: {
      retrieve: mockStripeSubscriptionsRetrieve,
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
const mockUser = (overrides: Partial<{ id: string }> = {}) => ({
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

describe('POST /api/stripe/reactivate-subscription', () => {
  const mockUserId = 'user_123';

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

    // Setup default Stripe mocks - subscription scheduled for cancellation
    mockStripeSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_123',
      cancel_at_period_end: true,
      status: 'active',
    });

    mockStripeSubscriptionsUpdate.mockResolvedValue({
      id: 'sub_123',
      cancel_at_period_end: false,
      status: 'active',
    });
  });

  it('should reactivate subscription successfully', async () => {
    const request = new Request('https://example.com/api/stripe/reactivate-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.subscriptionId).toBe('sub_123');
    expect(body.cancelAtPeriodEnd).toBe(false);
    expect(body.status).toBe('active');
    expect(body.message).toBe('Subscription reactivated successfully');
  });

  it('should update Stripe subscription with cancel_at_period_end false', async () => {
    const request = new Request('https://example.com/api/stripe/reactivate-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    await POST(request);

    expect(mockStripeSubscriptionsUpdate).toHaveBeenCalledWith(
      'sub_123',
      { cancel_at_period_end: false }
    );
  });

  it('should update local database record', async () => {
    const request = new Request('https://example.com/api/stripe/reactivate-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    await POST(request);

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        cancelAtPeriodEnd: false,
      })
    );
  });

  it('should return 400 when subscription is not scheduled for cancellation', async () => {
    mockStripeSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_123',
      cancel_at_period_end: false, // Not scheduled for cancellation
      status: 'active',
    });

    const request = new Request('https://example.com/api/stripe/reactivate-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Subscription is not scheduled for cancellation');
  });

  it('should return 404 when user not found', async () => {
    mockSelectWhere.mockResolvedValue([]);

    const request = new Request('https://example.com/api/stripe/reactivate-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('User not found');
  });

  it('should return 400 when no subscription found', async () => {
    let selectCallCount = 0;
    mockSelectWhere.mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return Promise.resolve([mockUser()]);
      }
      return Promise.resolve([]); // No subscription
    });

    const request = new Request('https://example.com/api/stripe/reactivate-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('No subscription found');
  });

  it('should return 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

    const request = new Request('https://example.com/api/stripe/reactivate-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it('should retrieve subscription to check cancellation status first', async () => {
    const request = new Request('https://example.com/api/stripe/reactivate-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    await POST(request);

    expect(mockStripeSubscriptionsRetrieve).toHaveBeenCalledWith('sub_123');
    // Verify retrieve was called (update is called after)
    expect(mockStripeSubscriptionsUpdate).toHaveBeenCalled();
  });
});
