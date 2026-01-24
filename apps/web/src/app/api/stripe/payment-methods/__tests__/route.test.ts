import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock Stripe - use vi.hoisted to ensure mocks are available before vi.mock
const {
  mockStripeCustomersRetrieve,
  mockStripeCustomersUpdate,
  mockStripePaymentMethodsList,
  mockStripePaymentMethodsRetrieve,
  mockStripePaymentMethodsDetach,
  StripeError,
} = vi.hoisted(() => {
  const StripeError = class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'StripeError';
    }
  };
  return {
    mockStripeCustomersRetrieve: vi.fn(),
    mockStripeCustomersUpdate: vi.fn(),
    mockStripePaymentMethodsList: vi.fn(),
    mockStripePaymentMethodsRetrieve: vi.fn(),
    mockStripePaymentMethodsDetach: vi.fn(),
    StripeError,
  };
});

vi.mock('@/lib/stripe', () => ({
  stripe: {
    customers: {
      retrieve: mockStripeCustomersRetrieve,
      update: mockStripeCustomersUpdate,
    },
    paymentMethods: {
      list: mockStripePaymentMethodsList,
      retrieve: mockStripePaymentMethodsRetrieve,
      detach: mockStripePaymentMethodsDetach,
    },
  },
  Stripe: {
    errors: { StripeError },
  },
}));

// Mock database
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
import { GET, DELETE, PATCH } from '../route';
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
const mockUser = (overrides: Partial<{
  id: string;
  stripeCustomerId: string | null;
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  stripeCustomerId: 'stripeCustomerId' in overrides ? overrides.stripeCustomerId : 'cus_123',
});

// Helper to create mock payment method
const mockPaymentMethod = (overrides: Partial<{
  id: string;
  customer: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}> = {}) => ({
  id: overrides.id ?? 'pm_123',
  customer: overrides.customer ?? 'cus_123',
  card: {
    brand: overrides.brand ?? 'visa',
    last4: overrides.last4 ?? '4242',
    exp_month: overrides.expMonth ?? 12,
    exp_year: overrides.expYear ?? 2030,
  },
});

describe('Payment Methods API', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Setup default database response
    mockSelectWhere.mockResolvedValue([mockUser()]);

    // Setup default Stripe mocks
    mockStripeCustomersRetrieve.mockResolvedValue({
      id: 'cus_123',
      deleted: false,
      invoice_settings: {
        default_payment_method: 'pm_123',
      },
    });

    mockStripePaymentMethodsList.mockResolvedValue({
      data: [mockPaymentMethod()],
    });

    mockStripePaymentMethodsRetrieve.mockResolvedValue(mockPaymentMethod());
    mockStripePaymentMethodsDetach.mockResolvedValue({ id: 'pm_123' });
    mockStripeCustomersUpdate.mockResolvedValue({ id: 'cus_123' });
  });

  describe('GET /api/stripe/payment-methods', () => {
    it('should list payment methods successfully', async () => {
      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.paymentMethods).toHaveLength(1);
      expect(body.paymentMethods[0]).toEqual({
        id: 'pm_123',
        brand: 'visa',
        last4: '4242',
        expMonth: 12,
        expYear: 2030,
        isDefault: true,
      });
      expect(body.defaultPaymentMethodId).toBe('pm_123');
    });

    it('should return empty array when user has no Stripe customer', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: null })]);

      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.paymentMethods).toEqual([]);
      expect(body.defaultPaymentMethodId).toBeNull();
    });

    it('should return empty array when customer is deleted', async () => {
      mockStripeCustomersRetrieve.mockResolvedValue({
        id: 'cus_123',
        deleted: true,
      });

      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.paymentMethods).toEqual([]);
      expect(body.defaultPaymentMethodId).toBeNull();
    });

    it('should mark correct payment method as default', async () => {
      mockStripeCustomersRetrieve.mockResolvedValue({
        id: 'cus_123',
        deleted: false,
        invoice_settings: {
          default_payment_method: 'pm_456',
        },
      });

      mockStripePaymentMethodsList.mockResolvedValue({
        data: [
          mockPaymentMethod({ id: 'pm_123' }),
          mockPaymentMethod({ id: 'pm_456', brand: 'mastercard', last4: '5555' }),
        ],
      });

      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(body.paymentMethods[0].isDefault).toBe(false);
      expect(body.paymentMethods[1].isDefault).toBe(true);
    });

    it('should return 404 when user not found', async () => {
      mockSelectWhere.mockResolvedValue([]);

      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('DELETE /api/stripe/payment-methods', () => {
    it('should detach payment method successfully', async () => {
      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'DELETE',
        body: JSON.stringify({ paymentMethodId: 'pm_123' }),
      }) as unknown as import('next/server').NextRequest;

      const response = await DELETE(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockStripePaymentMethodsDetach).toHaveBeenCalledWith('pm_123');
    });

    it('should return 400 when paymentMethodId is missing', async () => {
      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'DELETE',
        body: JSON.stringify({}),
      }) as unknown as import('next/server').NextRequest;

      const response = await DELETE(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Payment method ID is required');
    });

    it('should return 404 when user not found', async () => {
      mockSelectWhere.mockResolvedValue([]);

      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'DELETE',
        body: JSON.stringify({ paymentMethodId: 'pm_123' }),
      }) as unknown as import('next/server').NextRequest;

      const response = await DELETE(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should return 400 when user has no Stripe customer', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: null })]);

      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'DELETE',
        body: JSON.stringify({ paymentMethodId: 'pm_123' }),
      }) as unknown as import('next/server').NextRequest;

      const response = await DELETE(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('No customer found');
    });

    it('should return 404 when payment method belongs to different customer', async () => {
      mockStripePaymentMethodsRetrieve.mockResolvedValue(
        mockPaymentMethod({ customer: 'cus_different' })
      );

      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'DELETE',
        body: JSON.stringify({ paymentMethodId: 'pm_123' }),
      }) as unknown as import('next/server').NextRequest;

      const response = await DELETE(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Payment method not found');
      expect(mockStripePaymentMethodsDetach).not.toHaveBeenCalled();
    });

    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'DELETE',
        body: JSON.stringify({ paymentMethodId: 'pm_123' }),
      }) as unknown as import('next/server').NextRequest;

      const response = await DELETE(request);

      expect(response.status).toBe(401);
    });
  });

  describe('PATCH /api/stripe/payment-methods', () => {
    it('should set default payment method successfully', async () => {
      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'PATCH',
        body: JSON.stringify({ paymentMethodId: 'pm_456' }),
      }) as unknown as import('next/server').NextRequest;

      mockStripePaymentMethodsRetrieve.mockResolvedValue(
        mockPaymentMethod({ id: 'pm_456' })
      );

      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.defaultPaymentMethodId).toBe('pm_456');
      expect(mockStripeCustomersUpdate).toHaveBeenCalledWith('cus_123', {
        invoice_settings: {
          default_payment_method: 'pm_456',
        },
      });
    });

    it('should return 400 when paymentMethodId is missing', async () => {
      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'PATCH',
        body: JSON.stringify({}),
      }) as unknown as import('next/server').NextRequest;

      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Payment method ID is required');
    });

    it('should return 404 when user not found', async () => {
      mockSelectWhere.mockResolvedValue([]);

      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'PATCH',
        body: JSON.stringify({ paymentMethodId: 'pm_123' }),
      }) as unknown as import('next/server').NextRequest;

      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should return 400 when user has no Stripe customer', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: null })]);

      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'PATCH',
        body: JSON.stringify({ paymentMethodId: 'pm_123' }),
      }) as unknown as import('next/server').NextRequest;

      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('No customer found');
    });

    it('should return 404 when payment method belongs to different customer', async () => {
      mockStripePaymentMethodsRetrieve.mockResolvedValue(
        mockPaymentMethod({ customer: 'cus_different' })
      );

      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'PATCH',
        body: JSON.stringify({ paymentMethodId: 'pm_123' }),
      }) as unknown as import('next/server').NextRequest;

      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Payment method not found');
      expect(mockStripeCustomersUpdate).not.toHaveBeenCalled();
    });

    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'PATCH',
        body: JSON.stringify({ paymentMethodId: 'pm_123' }),
      }) as unknown as import('next/server').NextRequest;

      const response = await PATCH(request);

      expect(response.status).toBe(401);
    });
  });

  describe('Ownership Validation', () => {
    it('should verify payment method ownership before detach', async () => {
      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'DELETE',
        body: JSON.stringify({ paymentMethodId: 'pm_123' }),
      }) as unknown as import('next/server').NextRequest;

      await DELETE(request);

      expect(mockStripePaymentMethodsRetrieve).toHaveBeenCalledWith('pm_123');
    });

    it('should verify payment method ownership before setting default', async () => {
      const request = new Request('https://example.com/api/stripe/payment-methods', {
        method: 'PATCH',
        body: JSON.stringify({ paymentMethodId: 'pm_123' }),
      }) as unknown as import('next/server').NextRequest;

      await PATCH(request);

      expect(mockStripePaymentMethodsRetrieve).toHaveBeenCalledWith('pm_123');
    });
  });
});
