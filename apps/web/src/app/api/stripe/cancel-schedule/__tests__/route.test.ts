import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Helper to create mock NextRequest for testing
const createMockRequest = (url: string, init?: RequestInit): NextRequest => {
  return new Request(url, init) as unknown as NextRequest;
};

// Mock Stripe - use vi.hoisted to ensure mocks are available before vi.mock
const {
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
    mockStripeSubscriptionSchedulesRelease: vi.fn(),
    StripeError,
  };
});

vi.mock('@/lib/stripe', () => ({
  stripe: {
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
});

// Mock auth
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Mock @pagespace/lib/server
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
const mockUser = (overrides: Partial<{
  id: string;
  stripeCustomerId: string | null;
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  stripeCustomerId: 'stripeCustomerId' in overrides ? overrides.stripeCustomerId : 'cus_123',
});

// Helper to create mock subscription (from database)
const mockDbSubscription = (overrides: Partial<{
  id: string;
  userId: string;
  stripeSubscriptionId: string | null;
  stripeScheduleId: string | null;
  status: string;
}> = {}) => ({
  id: overrides.id ?? 'local_sub_123',
  userId: overrides.userId ?? 'user_123',
  stripeSubscriptionId: overrides.stripeSubscriptionId ?? 'sub_123',
  stripeScheduleId: 'stripeScheduleId' in overrides ? overrides.stripeScheduleId : 'sch_123',
  status: overrides.status ?? 'active',
});

describe('POST /api/stripe/cancel-schedule', () => {
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

    // Setup default Stripe mocks
    mockStripeSubscriptionSchedulesRelease.mockResolvedValue({});
  });

  describe('Success cases', () => {
    it('should cancel pending schedule and clear database fields', async () => {
      const request = createMockRequest('https://example.com/api/stripe/cancel-schedule', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toBe('Pending plan change cancelled successfully');
    });

    it('should release schedule in Stripe', async () => {
      const request = createMockRequest('https://example.com/api/stripe/cancel-schedule', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      await POST(request);

      expect(mockStripeSubscriptionSchedulesRelease).toHaveBeenCalledWith('sch_123');
    });

    it('should log audit event on successful schedule cancellation', async () => {
      const request = createMockRequest('https://example.com/api/stripe/cancel-schedule', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      await POST(request);

      expect(auditRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'data.write', userId: mockUserId, resourceType: 'subscription_schedule', resourceId: 'sch_123', details: expect.objectContaining({ action: 'cancel' }) })
      );
    });

    it('should clear schedule info in database', async () => {
      const request = createMockRequest('https://example.com/api/stripe/cancel-schedule', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      await POST(request);

      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          stripeScheduleId: null,
          scheduledPriceId: null,
          scheduledChangeDate: null,
        })
      );
    });
  });

  describe('Error handling', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createMockRequest('https://example.com/api/stripe/cancel-schedule', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should return 404 when user not found', async () => {
      mockUserQuery.mockResolvedValue([]);

      const request = createMockRequest('https://example.com/api/stripe/cancel-schedule', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should return 400 when no active subscription found', async () => {
      mockSubscriptionQuery.mockResolvedValue([]);

      const request = createMockRequest('https://example.com/api/stripe/cancel-schedule', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('No active subscription found');
    });

    it('should return 400 when no pending schedule exists', async () => {
      mockSubscriptionQuery.mockResolvedValue([mockDbSubscription({ stripeScheduleId: null })]);

      const request = createMockRequest('https://example.com/api/stripe/cancel-schedule', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('No pending plan change to cancel');
    });

    it('should return 400 on Stripe API error', async () => {
      mockStripeSubscriptionSchedulesRelease.mockRejectedValue(
        new StripeError('Invalid schedule')
      );

      const request = createMockRequest('https://example.com/api/stripe/cancel-schedule', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid schedule');
    });

    it('should return 500 on unexpected error', async () => {
      mockStripeSubscriptionSchedulesRelease.mockRejectedValue(new Error('Unexpected error'));

      const request = createMockRequest('https://example.com/api/stripe/cancel-schedule', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to cancel pending plan change');
    });
  });
});
