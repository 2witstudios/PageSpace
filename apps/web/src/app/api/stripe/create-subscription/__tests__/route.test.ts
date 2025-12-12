import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock Stripe - use vi.hoisted to ensure mocks are available before vi.mock
const { mockStripeCustomersCreate, mockStripeCustomersDel, mockStripeSubscriptionsCreate, StripeError } = vi.hoisted(() => {
  const StripeError = class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'StripeError';
    }
  };
  return {
    mockStripeCustomersCreate: vi.fn(),
    mockStripeCustomersDel: vi.fn(),
    mockStripeSubscriptionsCreate: vi.fn(),
    StripeError,
  };
});

vi.mock('@/lib/stripe', () => ({
  stripe: {
    customers: {
      create: mockStripeCustomersCreate,
      del: mockStripeCustomersDel,
    },
    subscriptions: {
      create: mockStripeSubscriptionsCreate,
    },
  },
  Stripe: {
    errors: { StripeError },
  },
}));

// Mock database - using inline factory
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
    mockUpdateWhere.mockResolvedValue(undefined);
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });

    // Setup default Stripe mocks
    mockStripeCustomersCreate.mockResolvedValue({
      id: 'cus_new123',
    });

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
    const request = new Request('https://example.com/api/stripe/create-subscription', {
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

  it('should create Stripe customer if not exists', async () => {
    const request = new Request('https://example.com/api/stripe/create-subscription', {
      method: 'POST',
      body: JSON.stringify({ priceId: mockPriceId }),
    });

    await POST(request);

    expect(mockStripeCustomersCreate).toHaveBeenCalledWith({
      email: 'test@example.com',
      name: 'Test User',
      metadata: { userId: mockUserId },
    });
  });

  it('should use existing Stripe customer if available', async () => {
    mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: 'cus_existing123' })]);

    const request = new Request('https://example.com/api/stripe/create-subscription', {
      method: 'POST',
      body: JSON.stringify({ priceId: mockPriceId }),
    });

    await POST(request);

    expect(mockStripeCustomersCreate).not.toHaveBeenCalled();
    expect(mockStripeSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_existing123',
      })
    );
  });

  it('should return 400 when priceId is missing', async () => {
    const request = new Request('https://example.com/api/stripe/create-subscription', {
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

    const request = new Request('https://example.com/api/stripe/create-subscription', {
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

    const request = new Request('https://example.com/api/stripe/create-subscription', {
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

    const request = new Request('https://example.com/api/stripe/create-subscription', {
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

    const request = new Request('https://example.com/api/stripe/create-subscription', {
      method: 'POST',
      body: JSON.stringify({ priceId: mockPriceId }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Failed to create payment intent');
  });

  it('should create subscription with correct parameters', async () => {
    mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: 'cus_test' })]);

    const request = new Request('https://example.com/api/stripe/create-subscription', {
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

  it('should save new customer ID to database', async () => {
    const request = new Request('https://example.com/api/stripe/create-subscription', {
      method: 'POST',
      body: JSON.stringify({ priceId: mockPriceId }),
    });

    await POST(request);

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeCustomerId: 'cus_new123',
      })
    );
  });
});
