import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock Stripe - use vi.hoisted to ensure mocks are available before vi.mock
const {
  mockStripeCustomersRetrieve,
  mockStripeCustomersCreate,
  mockStripeCustomersUpdate,
  mockStripeCustomersDel,
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
    mockStripeCustomersCreate: vi.fn(),
    mockStripeCustomersUpdate: vi.fn(),
    mockStripeCustomersDel: vi.fn(),
    StripeError,
  };
});

vi.mock('@/lib/stripe', () => ({
  stripe: {
    customers: {
      retrieve: mockStripeCustomersRetrieve,
      create: mockStripeCustomersCreate,
      update: mockStripeCustomersUpdate,
      del: mockStripeCustomersDel,
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
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  };
});

// Mock auth
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Import after mocks
import { GET, PUT } from '../route';
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
  name: string;
  email: string;
  stripeCustomerId: string | null;
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  name: overrides.name ?? 'Test User',
  email: overrides.email ?? 'test@example.com',
  stripeCustomerId: 'stripeCustomerId' in overrides ? overrides.stripeCustomerId : 'cus_123',
});

// Helper to create mock address
const mockAddress = (overrides: Partial<{
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postal_code: string | null;
  country: string;
}> = {}) => ({
  line1: overrides.line1 ?? '123 Main St',
  line2: 'line2' in overrides ? overrides.line2 : null,
  city: overrides.city ?? 'San Francisco',
  state: 'state' in overrides ? overrides.state : 'CA',
  postal_code: 'postal_code' in overrides ? overrides.postal_code : '94102',
  country: overrides.country ?? 'US',
});

// Helper to create mock Stripe customer
const mockCustomer = (overrides: Partial<{
  id: string;
  deleted: boolean;
  name: string | null;
  email: string | null;
  address: ReturnType<typeof mockAddress> | null;
}> = {}) => ({
  id: overrides.id ?? 'cus_123',
  deleted: overrides.deleted ?? false,
  name: 'name' in overrides ? overrides.name : 'Test User',
  email: 'email' in overrides ? overrides.email : 'test@example.com',
  address: 'address' in overrides ? overrides.address : mockAddress(),
});

describe('Billing Address API', () => {
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
    mockStripeCustomersCreate.mockResolvedValue(mockCustomer());
    mockStripeCustomersUpdate.mockResolvedValue(mockCustomer());
    mockStripeCustomersDel.mockResolvedValue({ id: 'cus_123', deleted: true });
  });

  describe('GET /api/stripe/billing-address', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should return 404 when user not found', async () => {
      mockSelectWhere.mockResolvedValue([]);

      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should return null address with user info when no Stripe customer', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: null })]);

      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.address).toBeNull();
      expect(body.name).toBe('Test User');
      expect(body.email).toBe('test@example.com');
    });

    it('should return null address when Stripe customer is deleted', async () => {
      mockStripeCustomersRetrieve.mockResolvedValue({ id: 'cus_123', deleted: true });

      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.address).toBeNull();
      expect(body.name).toBe('Test User');
      expect(body.email).toBe('test@example.com');
    });

    it('should return address from Stripe customer', async () => {
      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.address).toEqual(mockAddress());
      expect(body.name).toBe('Test User');
      expect(body.email).toBe('test@example.com');
    });

    it('should prefer Stripe customer name/email over user data', async () => {
      mockStripeCustomersRetrieve.mockResolvedValue(
        mockCustomer({ name: 'Stripe Name', email: 'stripe@example.com' })
      );

      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(body.name).toBe('Stripe Name');
      expect(body.email).toBe('stripe@example.com');
    });

    it('should fallback to user name/email when Stripe customer has none', async () => {
      mockStripeCustomersRetrieve.mockResolvedValue(
        mockCustomer({ name: null, email: null })
      );

      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(body.name).toBe('Test User');
      expect(body.email).toBe('test@example.com');
    });

    it('should return 500 on generic errors', async () => {
      mockStripeCustomersRetrieve.mockRejectedValue(new Error('Network error'));

      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch billing address');
    });
  });

  describe('PUT /api/stripe/billing-address', () => {
    const validAddressBody = {
      name: 'Updated Name',
      address: {
        line1: '456 New St',
        city: 'Los Angeles',
        country: 'US',
      },
    };

    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'PUT',
        body: JSON.stringify(validAddressBody),
      }) as unknown as import('next/server').NextRequest;

      const response = await PUT(request);

      expect(response.status).toBe(401);
    });

    it('should return 400 when address line1 is missing', async () => {
      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'PUT',
        body: JSON.stringify({ address: { city: 'LA', country: 'US' } }),
      }) as unknown as import('next/server').NextRequest;

      const response = await PUT(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Address line1, city, and country are required');
    });

    it('should return 400 when city is missing', async () => {
      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'PUT',
        body: JSON.stringify({ address: { line1: '123 St', country: 'US' } }),
      }) as unknown as import('next/server').NextRequest;

      const response = await PUT(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Address line1, city, and country are required');
    });

    it('should return 400 when country is missing', async () => {
      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'PUT',
        body: JSON.stringify({ address: { line1: '123 St', city: 'LA' } }),
      }) as unknown as import('next/server').NextRequest;

      const response = await PUT(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Address line1, city, and country are required');
    });

    it('should return 400 when no address provided', async () => {
      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'PUT',
        body: JSON.stringify({ name: 'Test' }),
      }) as unknown as import('next/server').NextRequest;

      const response = await PUT(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Address line1, city, and country are required');
    });

    it('should return 404 when user not found', async () => {
      mockSelectWhere.mockResolvedValue([]);

      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'PUT',
        body: JSON.stringify(validAddressBody),
      }) as unknown as import('next/server').NextRequest;

      const response = await PUT(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should create Stripe customer when user has none', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: null })]);
      mockStripeCustomersCreate.mockResolvedValue(mockCustomer({
        id: 'cus_new',
        name: 'Updated Name',
        address: mockAddress({ line1: '456 New St', city: 'Los Angeles' }),
      }));

      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'PUT',
        body: JSON.stringify(validAddressBody),
      }) as unknown as import('next/server').NextRequest;

      const response = await PUT(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockStripeCustomersCreate).toHaveBeenCalledWith({
        email: 'test@example.com',
        name: 'Updated Name',
        address: {
          line1: '456 New St',
          line2: undefined,
          city: 'Los Angeles',
          state: undefined,
          postal_code: undefined,
          country: 'US',
        },
        metadata: { userId: 'user_123' },
      });
    });

    it('should save customer ID to database when creating customer', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: null })]);
      mockStripeCustomersCreate.mockResolvedValue(mockCustomer({ id: 'cus_new' }));

      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'PUT',
        body: JSON.stringify(validAddressBody),
      }) as unknown as import('next/server').NextRequest;

      await PUT(request);

      expect(mockUpdateSet).toHaveBeenCalledWith({
        stripeCustomerId: 'cus_new',
        updatedAt: expect.any(Date),
      });
    });

    it('should rollback and delete Stripe customer if DB update fails', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: null })]);
      mockStripeCustomersCreate.mockResolvedValue(mockCustomer({ id: 'cus_new' }));
      mockUpdateWhere.mockRejectedValue(new Error('DB connection failed'));

      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'PUT',
        body: JSON.stringify(validAddressBody),
      }) as unknown as import('next/server').NextRequest;

      const response = await PUT(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update billing address');
      expect(mockStripeCustomersDel).toHaveBeenCalledWith('cus_new');
    });

    it('should update existing Stripe customer', async () => {
      mockStripeCustomersUpdate.mockResolvedValue(mockCustomer({
        name: 'Updated Name',
        address: mockAddress({ line1: '456 New St', city: 'Los Angeles' }),
      }));

      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'PUT',
        body: JSON.stringify(validAddressBody),
      }) as unknown as import('next/server').NextRequest;

      const response = await PUT(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockStripeCustomersUpdate).toHaveBeenCalledWith('cus_123', {
        name: 'Updated Name',
        address: {
          line1: '456 New St',
          line2: undefined,
          city: 'Los Angeles',
          state: undefined,
          postal_code: undefined,
          country: 'US',
        },
      });
    });

    it('should handle full address with all optional fields', async () => {
      const fullAddressBody = {
        name: 'Full Name',
        address: {
          line1: '123 Main St',
          line2: 'Suite 100',
          city: 'San Francisco',
          state: 'CA',
          postal_code: '94102',
          country: 'US',
        },
      };

      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'PUT',
        body: JSON.stringify(fullAddressBody),
      }) as unknown as import('next/server').NextRequest;

      await PUT(request);

      expect(mockStripeCustomersUpdate).toHaveBeenCalledWith('cus_123', {
        name: 'Full Name',
        address: {
          line1: '123 Main St',
          line2: 'Suite 100',
          city: 'San Francisco',
          state: 'CA',
          postal_code: '94102',
          country: 'US',
        },
      });
    });

    it('should return 400 on Stripe errors', async () => {
      mockStripeCustomersUpdate.mockRejectedValue(new StripeError('Invalid postal code'));

      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'PUT',
        body: JSON.stringify(validAddressBody),
      }) as unknown as import('next/server').NextRequest;

      const response = await PUT(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid postal code');
    });

    it('should return 500 on generic errors', async () => {
      mockStripeCustomersUpdate.mockRejectedValue(new Error('Network error'));

      const request = new Request('https://example.com/api/stripe/billing-address', {
        method: 'PUT',
        body: JSON.stringify(validAddressBody),
      }) as unknown as import('next/server').NextRequest;

      const response = await PUT(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update billing address');
    });
  });
});
