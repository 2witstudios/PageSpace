import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

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
  mockStripeSubscriptionsCancel,
  mockStripePaymentIntentsCancel,
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
    mockStripeSubscriptionsRetrieve: vi.fn(),
    mockStripeSubscriptionsCancel: vi.fn(),
    mockStripePaymentIntentsCancel: vi.fn(),
    StripeError,
  };
});

vi.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: {
      retrieve: mockStripeSubscriptionsRetrieve,
      cancel: mockStripeSubscriptionsCancel,
    },
    paymentIntents: {
      cancel: mockStripePaymentIntentsCancel,
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
      warn: vi.fn(),
    },
  },
}));

// Import after mocks
import { POST } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

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
const mockUser = (
  overrides: Partial<{
    id: string;
    stripeCustomerId: string | null;
    subscriptionTier: string;
  }> = {}
) => ({
  id: overrides.id ?? 'user_123',
  stripeCustomerId: overrides.stripeCustomerId ?? 'cus_123',
  subscriptionTier: overrides.subscriptionTier ?? 'free',
});

// Helper to create mock subscription with expanded invoice
const mockSubscription = (
  overrides: Partial<{
    id: string;
    status: string;
    metadata: { userId?: string };
    customer: string;
    latest_invoice: {
      id: string;
      payment_intent: { id: string; status: string } | null;
    };
  }> = {}
) => ({
  id: overrides.id ?? 'sub_123',
  status: overrides.status ?? 'incomplete',
  metadata: overrides.metadata ?? { userId: 'user_123' },
  customer: overrides.customer ?? 'cus_123',
  latest_invoice: overrides.latest_invoice ?? {
    id: 'in_123',
    payment_intent: { id: 'pi_123', status: 'requires_payment_method' },
  },
});

describe('POST /api/stripe/cancel-checkout', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(
      mockWebAuth(mockUserId)
    );
    vi.mocked(isAuthError).mockReturnValue(false);

    // Setup default database mock
    mockDbSelect.mockResolvedValue([mockUser()]);

    // Setup default Stripe mocks
    mockStripeSubscriptionsRetrieve.mockResolvedValue(mockSubscription());
    mockStripePaymentIntentsCancel.mockResolvedValue({
      id: 'pi_123',
      status: 'canceled',
    });
    mockStripeSubscriptionsCancel.mockResolvedValue({
      id: 'sub_123',
      status: 'canceled',
    });
  });

  describe('Success cases', () => {
    it('should cancel incomplete subscription and payment intent', async () => {
      const request = createMockRequest(
        'https://example.com/api/stripe/cancel-checkout',
        {
          method: 'POST',
          body: JSON.stringify({ subscriptionId: 'sub_123' }),
        }
      );

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toBe('Checkout canceled successfully');

      // Should cancel payment intent first
      expect(mockStripePaymentIntentsCancel).toHaveBeenCalledWith('pi_123');
      // Then cancel subscription
      expect(mockStripeSubscriptionsCancel).toHaveBeenCalledWith('sub_123');
    });

    it('should handle case where payment intent is already canceled', async () => {
      mockStripeSubscriptionsRetrieve.mockResolvedValue(
        mockSubscription({
          latest_invoice: {
            id: 'in_123',
            payment_intent: { id: 'pi_123', status: 'canceled' },
          },
        })
      );

      const request = createMockRequest(
        'https://example.com/api/stripe/cancel-checkout',
        {
          method: 'POST',
          body: JSON.stringify({ subscriptionId: 'sub_123' }),
        }
      );

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // Should NOT try to cancel already-canceled payment intent
      expect(mockStripePaymentIntentsCancel).not.toHaveBeenCalled();
      // Should still cancel subscription
      expect(mockStripeSubscriptionsCancel).toHaveBeenCalledWith('sub_123');
    });

    it('should handle case where no payment intent exists', async () => {
      mockStripeSubscriptionsRetrieve.mockResolvedValue(
        mockSubscription({
          latest_invoice: {
            id: 'in_123',
            payment_intent: null,
          },
        })
      );

      const request = createMockRequest(
        'https://example.com/api/stripe/cancel-checkout',
        {
          method: 'POST',
          body: JSON.stringify({ subscriptionId: 'sub_123' }),
        }
      );

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // Should NOT try to cancel null payment intent
      expect(mockStripePaymentIntentsCancel).not.toHaveBeenCalled();
      // Should still cancel subscription
      expect(mockStripeSubscriptionsCancel).toHaveBeenCalledWith('sub_123');
    });
  });

  describe('Validation errors', () => {
    it('should return 400 when subscriptionId is missing', async () => {
      const request = createMockRequest(
        'https://example.com/api/stripe/cancel-checkout',
        {
          method: 'POST',
          body: JSON.stringify({}),
        }
      );

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Subscription ID is required');
    });

    it('should return 404 when user is not found', async () => {
      mockDbSelect.mockResolvedValue([]);

      const request = createMockRequest(
        'https://example.com/api/stripe/cancel-checkout',
        {
          method: 'POST',
          body: JSON.stringify({ subscriptionId: 'sub_123' }),
        }
      );

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should return 404 when subscription does not belong to user', async () => {
      mockStripeSubscriptionsRetrieve.mockResolvedValue(
        mockSubscription({ metadata: { userId: 'other_user' } })
      );

      const request = createMockRequest(
        'https://example.com/api/stripe/cancel-checkout',
        {
          method: 'POST',
          body: JSON.stringify({ subscriptionId: 'sub_123' }),
        }
      );

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Subscription not found');
    });

    it('should return 400 when subscription is not incomplete (safety check)', async () => {
      mockStripeSubscriptionsRetrieve.mockResolvedValue(
        mockSubscription({ status: 'active' })
      );

      const request = createMockRequest(
        'https://example.com/api/stripe/cancel-checkout',
        {
          method: 'POST',
          body: JSON.stringify({ subscriptionId: 'sub_123' }),
        }
      );

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe(
        'Only incomplete subscriptions can be canceled via this endpoint'
      );
    });

    it('should return 400 for canceled subscription status', async () => {
      mockStripeSubscriptionsRetrieve.mockResolvedValue(
        mockSubscription({ status: 'canceled' })
      );

      const request = createMockRequest(
        'https://example.com/api/stripe/cancel-checkout',
        {
          method: 'POST',
          body: JSON.stringify({ subscriptionId: 'sub_123' }),
        }
      );

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe(
        'Only incomplete subscriptions can be canceled via this endpoint'
      );
    });
  });

  describe('Error handling', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(
        mockAuthError(401)
      );

      const request = createMockRequest(
        'https://example.com/api/stripe/cancel-checkout',
        {
          method: 'POST',
          body: JSON.stringify({ subscriptionId: 'sub_123' }),
        }
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should return success even on Stripe errors (graceful degradation)', async () => {
      mockStripeSubscriptionsCancel.mockRejectedValue(
        new StripeError('Subscription not found', 'resource_missing')
      );

      const request = createMockRequest(
        'https://example.com/api/stripe/cancel-checkout',
        {
          method: 'POST',
          body: JSON.stringify({ subscriptionId: 'sub_123' }),
        }
      );

      const response = await POST(request);
      const body = await response.json();

      // Should return success anyway - graceful degradation for cleanup
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('should return 500 on unexpected non-Stripe errors', async () => {
      mockStripeSubscriptionsRetrieve.mockRejectedValue(
        new Error('Database connection lost')
      );

      const request = createMockRequest(
        'https://example.com/api/stripe/cancel-checkout',
        {
          method: 'POST',
          body: JSON.stringify({ subscriptionId: 'sub_123' }),
        }
      );

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to cancel checkout');
    });
  });
});
