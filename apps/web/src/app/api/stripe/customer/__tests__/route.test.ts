import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock Stripe - use vi.hoisted to ensure mocks are available before vi.mock
const {
  mockStripeCustomersRetrieve,
  mockStripeCustomersCreate,
  mockStripeCustomersDel,
} = vi.hoisted(() => {
  return {
    mockStripeCustomersRetrieve: vi.fn(),
    mockStripeCustomersCreate: vi.fn(),
    mockStripeCustomersDel: vi.fn(),
  };
});

vi.mock('@/lib/stripe', () => ({
  stripe: {
    customers: {
      retrieve: mockStripeCustomersRetrieve,
      create: mockStripeCustomersCreate,
      del: mockStripeCustomersDel,
    },
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
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  };
});

// Mock auth
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Import after mocks
import { GET, POST } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// Helper to create mock SessionAuthResult
const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock user
const mockUser = (overrides: Partial<{
  id: string;
  name: string | null;
  email: string;
  stripeCustomerId: string | null;
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  name: 'name' in overrides ? overrides.name : 'Test User',
  email: overrides.email ?? 'test@example.com',
  stripeCustomerId: 'stripeCustomerId' in overrides ? overrides.stripeCustomerId : 'cus_123',
});

// Helper to create mock Stripe customer
const mockCustomer = (overrides: Partial<{
  id: string;
  deleted: boolean;
  email: string | null;
  name: string | null;
  address: object | null;
  defaultPaymentMethod: string | null;
}> = {}) => ({
  id: overrides.id ?? 'cus_123',
  deleted: overrides.deleted ?? false,
  email: 'email' in overrides ? overrides.email : 'test@example.com',
  name: 'name' in overrides ? overrides.name : 'Test User',
  address: 'address' in overrides ? overrides.address : { city: 'SF' },
  invoice_settings: {
    default_payment_method: 'defaultPaymentMethod' in overrides ? overrides.defaultPaymentMethod : 'pm_123',
  },
});

describe('Customer API', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Setup default database response
    mockSelectWhere.mockResolvedValue([mockUser()]);
    mockUpdateWhere.mockResolvedValue(undefined);

    // Setup default Stripe mocks
    mockStripeCustomersRetrieve.mockResolvedValue(mockCustomer());
    mockStripeCustomersCreate.mockResolvedValue(mockCustomer({ id: 'cus_new' }));
    mockStripeCustomersDel.mockResolvedValue({ id: 'cus_123', deleted: true });
  });

  describe('GET /api/stripe/customer', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/stripe/customer', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should return 404 when user not found', async () => {
      mockSelectWhere.mockResolvedValue([]);

      const request = new Request('https://example.com/api/stripe/customer', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should return null customer when user has no Stripe customer', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: null })]);

      const request = new Request('https://example.com/api/stripe/customer', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.customer).toBeNull();
    });

    it('should return customer details when customer exists', async () => {
      const request = new Request('https://example.com/api/stripe/customer', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.customer).toEqual({
        id: 'cus_123',
        email: 'test@example.com',
        name: 'Test User',
        address: { city: 'SF' },
        defaultPaymentMethod: 'pm_123',
      });
    });

    it('should clear DB reference and return null when customer deleted in Stripe', async () => {
      mockStripeCustomersRetrieve.mockResolvedValue({ id: 'cus_123', deleted: true });

      const request = new Request('https://example.com/api/stripe/customer', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.customer).toBeNull();
      expect(mockUpdateSet).toHaveBeenCalledWith({
        stripeCustomerId: null,
        updatedAt: expect.any(Date),
      });
    });

    it('should return 500 on errors', async () => {
      mockStripeCustomersRetrieve.mockRejectedValue(new Error('Stripe error'));

      const request = new Request('https://example.com/api/stripe/customer', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch customer');
    });
  });

  describe('POST /api/stripe/customer', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/stripe/customer', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should return 404 when user not found', async () => {
      mockSelectWhere.mockResolvedValue([]);

      const request = new Request('https://example.com/api/stripe/customer', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should return existing customer with created: false', async () => {
      const request = new Request('https://example.com/api/stripe/customer', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.created).toBe(false);
      expect(body.customer.id).toBe('cus_123');
      expect(mockStripeCustomersCreate).not.toHaveBeenCalled();
    });

    it('should create new customer when user has none', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: null })]);

      const request = new Request('https://example.com/api/stripe/customer', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.created).toBe(true);
      expect(body.customer.id).toBe('cus_new');
      expect(mockStripeCustomersCreate).toHaveBeenCalledWith({
        email: 'test@example.com',
        name: 'Test User',
        metadata: { userId: 'user_123' },
      });
    });

    it('should create new customer when existing is deleted in Stripe', async () => {
      mockStripeCustomersRetrieve.mockResolvedValue({ id: 'cus_123', deleted: true });

      const request = new Request('https://example.com/api/stripe/customer', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.created).toBe(true);
      expect(mockStripeCustomersCreate).toHaveBeenCalled();
    });

    it('should save new customer ID to database', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: null })]);

      const request = new Request('https://example.com/api/stripe/customer', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      await POST(request);

      expect(mockUpdateSet).toHaveBeenCalledWith({
        stripeCustomerId: 'cus_new',
        updatedAt: expect.any(Date),
      });
    });

    it('should handle null user name when creating customer', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: null, name: null })]);

      const request = new Request('https://example.com/api/stripe/customer', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      await POST(request);

      expect(mockStripeCustomersCreate).toHaveBeenCalledWith({
        email: 'test@example.com',
        name: undefined,
        metadata: { userId: 'user_123' },
      });
    });

    it('should rollback and delete Stripe customer if DB update fails', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: null })]);
      mockUpdateWhere.mockRejectedValue(new Error('DB connection failed'));

      const request = new Request('https://example.com/api/stripe/customer', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create customer');
      expect(mockStripeCustomersDel).toHaveBeenCalledWith('cus_new');
    });

    it('should return 500 on errors', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: null })]);
      mockStripeCustomersCreate.mockRejectedValue(new Error('Stripe error'));

      const request = new Request('https://example.com/api/stripe/customer', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create customer');
    });
  });
});
