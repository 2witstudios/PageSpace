import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Helper to create mock NextRequest for testing
const createMockRequest = (url: string, init?: RequestInit): NextRequest => {
  return new Request(url, init) as unknown as NextRequest;
};

// Mock Stripe - use vi.hoisted to ensure mocks are available before vi.mock
const { mockStripeSubscriptionsCreate, mockGetOrCreateStripeCustomer, StripeError } = vi.hoisted(() => {
  const StripeError = class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'StripeError';
    }
  };
  return {
    mockStripeSubscriptionsCreate: vi.fn(),
    mockGetOrCreateStripeCustomer: vi.fn(),
    StripeError,
  };
});

vi.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: {
      create: mockStripeSubscriptionsCreate,
    },
  },
  Stripe: {
    errors: { StripeError },
  },
}));

// Mock stripe-customer module
vi.mock('@/lib/stripe-customer', () => ({
  getOrCreateStripeCustomer: mockGetOrCreateStripeCustomer,
}));

// Mock database - using inline factory
const mockSelectWhere = vi.fn();

vi.mock('@pagespace/db', () => {
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: mockSelectWhere,
        })),
      })),
    },
    users: {},
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
  email: string;
  name: string | null;
  subscriptionTier: string;
  stripeCustomerId: string | null;
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  name: overrides.name ?? 'Test User',
  email: overrides.email ?? 'test@example.com',
  subscriptionTier: overrides.subscriptionTier ?? 'free',
  stripeCustomerId: overrides.stripeCustomerId ?? null,
});

describe('POST /api/stripe/create-subscription', () => {
  const mockUserId = 'user_123';
  const mockPriceId = 'price_pro_monthly';

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Setup default user (free tier, no stripe customer)
    mockSelectWhere.mockResolvedValue([mockUser()]);

    // Setup default stripe-customer mock (returns customer ID)
    mockGetOrCreateStripeCustomer.mockResolvedValue('cus_new123');

    // Setup default Stripe mocks
    mockStripeSubscriptionsCreate.mockResolvedValue({
      id: 'sub_123',
      status: 'incomplete',
      latest_invoice: {
        confirmation_secret: {
          client_secret: 'pi_secret_123',
          type: 'payment_intent',
        },
      },
    });
  });

  it('should create subscription successfully for free user', async () => {
    const request = createMockRequest('https://example.com/api/stripe/create-subscription', {
      method: 'POST',
      body: JSON.stringify({ priceId: mockPriceId }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.subscriptionId).toBe('sub_123');
    expect(body.clientSecret).toBe('pi_secret_123');
    expect(body.status).toBe('incomplete');
  });

  it('should call getOrCreateStripeCustomer with user', async () => {
    const request = createMockRequest('https://example.com/api/stripe/create-subscription', {
      method: 'POST',
      body: JSON.stringify({ priceId: mockPriceId }),
    });

    await POST(request);

    // Verify getOrCreateStripeCustomer was called with the user object
    expect(mockGetOrCreateStripeCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: mockUserId,
        email: 'test@example.com',
        name: 'Test User',
      })
    );
  });

  it('should use customer ID from getOrCreateStripeCustomer', async () => {
    // Mock returns an existing customer ID
    mockGetOrCreateStripeCustomer.mockResolvedValue('cus_existing123');
    mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: 'cus_existing123' })]);

    const request = createMockRequest('https://example.com/api/stripe/create-subscription', {
      method: 'POST',
      body: JSON.stringify({ priceId: mockPriceId }),
    });

    await POST(request);

    // The customer ID from getOrCreateStripeCustomer should be used
    expect(mockStripeSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_existing123',
      })
    );
  });

  it('should return 400 when priceId is missing', async () => {
    const request = createMockRequest('https://example.com/api/stripe/create-subscription', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Price ID is required');
  });

  it('should return 404 when user not found', async () => {
    mockSelectWhere.mockResolvedValue([]);

    const request = createMockRequest('https://example.com/api/stripe/create-subscription', {
      method: 'POST',
      body: JSON.stringify({ priceId: mockPriceId }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('User not found');
  });

  it('should return 400 when user already has paid subscription', async () => {
    mockSelectWhere.mockResolvedValue([mockUser({ subscriptionTier: 'pro' })]);

    const request = createMockRequest('https://example.com/api/stripe/create-subscription', {
      method: 'POST',
      body: JSON.stringify({ priceId: mockPriceId }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('already has an active subscription');
  });

  it('should return 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

    const request = createMockRequest('https://example.com/api/stripe/create-subscription', {
      method: 'POST',
      body: JSON.stringify({ priceId: mockPriceId }),
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it('should return 500 when no client secret is returned', async () => {
    mockStripeSubscriptionsCreate.mockResolvedValue({
      id: 'sub_123',
      status: 'incomplete',
      latest_invoice: {
        // No confirmation_secret
      },
    });

    const request = createMockRequest('https://example.com/api/stripe/create-subscription', {
      method: 'POST',
      body: JSON.stringify({ priceId: mockPriceId }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Failed to create payment intent');
  });

  it('should create subscription with correct parameters', async () => {
    mockGetOrCreateStripeCustomer.mockResolvedValue('cus_test');
    mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: 'cus_test' })]);

    const request = createMockRequest('https://example.com/api/stripe/create-subscription', {
      method: 'POST',
      body: JSON.stringify({ priceId: mockPriceId }),
    });

    await POST(request);

    expect(mockStripeSubscriptionsCreate).toHaveBeenCalledWith({
      customer: 'cus_test',
      items: [{ price: mockPriceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription',
      },
      expand: ['latest_invoice.confirmation_secret'],
      metadata: { userId: mockUserId },
    });
  });

});
