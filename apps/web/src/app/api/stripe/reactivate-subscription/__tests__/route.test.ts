import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Helper to create mock NextRequest for testing
const createMockRequest = (url: string, init?: RequestInit): NextRequest => {
  return new Request(url, init) as unknown as NextRequest;
};

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

vi.mock('@pagespace/db/db', () => {
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
  };
});
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  and: vi.fn((...args: unknown[]) => ({ args, type: 'and' })),
  inArray: vi.fn((field: unknown, values: unknown) => ({ field, values, type: 'inArray' })),
  desc: vi.fn((field: unknown) => ({ field, type: 'desc' })),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: usersTable,
}));
vi.mock('@pagespace/db/schema/subscriptions', () => ({
  subscriptions: subscriptionsTable,
}));

// Mock auth
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { warn: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

// Import after mocks
import { POST } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

// Helper to create mock SessionAuthResult
const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
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
  status: string;
}> = {}) => ({
  id: overrides.id ?? 'local_sub_123',
  userId: overrides.userId ?? 'user_123',
  stripeSubscriptionId: 'stripeSubscriptionId' in overrides ? overrides.stripeSubscriptionId : 'sub_123',
  status: overrides.status ?? 'active',
});

describe('POST /api/stripe/reactivate-subscription', () => {
  const mockUserId = 'user_123';

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
    const request = createMockRequest('https://example.com/api/stripe/reactivate-subscription', {
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
    const request = createMockRequest('https://example.com/api/stripe/reactivate-subscription', {
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
    const request = createMockRequest('https://example.com/api/stripe/reactivate-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    await POST(request);

    const setArg = vi.mocked(mockUpdateSet).mock.calls[0][0];
    expect(setArg.cancelAtPeriodEnd).toBe(false);
    expect(setArg.stripeScheduleId).toBeNull();
    expect(setArg.scheduledPriceId).toBeNull();
    expect(setArg.scheduledChangeDate).toBeNull();
    expect(setArg.updatedAt).toBeInstanceOf(Date);
  });

  it('should return 400 when subscription is not scheduled for cancellation', async () => {
    mockStripeSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_123',
      cancel_at_period_end: false, // Not scheduled for cancellation
      status: 'active',
    });

    const request = createMockRequest('https://example.com/api/stripe/reactivate-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Subscription is not scheduled for cancellation');
  });

  it('should return 404 when user not found', async () => {
    mockUserQuery.mockResolvedValue([]);

    const request = createMockRequest('https://example.com/api/stripe/reactivate-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('User not found');
  });

  it('should return 400 when no subscription found', async () => {
    mockUserQuery.mockResolvedValue([mockUser()]);
    mockSubscriptionQuery.mockResolvedValue([]); // No subscription

    const request = createMockRequest('https://example.com/api/stripe/reactivate-subscription', {
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

    const request = createMockRequest('https://example.com/api/stripe/reactivate-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it('should log audit event on successful reactivation', async () => {
    const request = createMockRequest('https://example.com/api/stripe/reactivate-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    await POST(request);

    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write', userId: mockUserId, resourceType: 'subscription', resourceId: 'sub_123', details: expect.objectContaining({ action: 'reactivate' }) })
    );
  });

  it('should retrieve subscription to check cancellation status first', async () => {
    const request = createMockRequest('https://example.com/api/stripe/reactivate-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    await POST(request);

    expect(mockStripeSubscriptionsRetrieve).toHaveBeenCalledWith('sub_123');
    // Verify update was called after retrieve
    expect(mockStripeSubscriptionsUpdate).toHaveBeenCalledWith(
      'sub_123',
      { cancel_at_period_end: false }
    );
  });
});
