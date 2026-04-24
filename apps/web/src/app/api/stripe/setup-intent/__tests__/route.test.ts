import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock Stripe - use vi.hoisted to ensure mocks are available before vi.mock
const {
  mockStripeCustomersCreate,
  mockStripeCustomersDel,
  mockStripeSetupIntentsCreate,
  StripeError,
} = vi.hoisted(() => {
  const StripeError = class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'StripeError';
    }
  };
  return {
    mockStripeCustomersCreate: vi.fn(),
    mockStripeCustomersDel: vi.fn(),
    mockStripeSetupIntentsCreate: vi.fn(),
    StripeError,
  };
});

vi.mock('@/lib/stripe', () => ({
  stripe: {
    customers: {
      create: mockStripeCustomersCreate,
      del: mockStripeCustomersDel,
    },
    setupIntents: {
      create: mockStripeSetupIntentsCreate,
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
  name: string | null;
  email: string;
  stripeCustomerId: string | null;
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  name: 'name' in overrides ? overrides.name : 'Test User',
  email: overrides.email ?? 'test@example.com',
  stripeCustomerId: 'stripeCustomerId' in overrides ? overrides.stripeCustomerId : 'cus_123',
});

describe('Setup Intent API', () => {
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
    mockStripeCustomersCreate.mockResolvedValue({ id: 'cus_new' });
    mockStripeCustomersDel.mockResolvedValue({ id: 'cus_new', deleted: true });
    mockStripeSetupIntentsCreate.mockResolvedValue({
      id: 'seti_123',
      client_secret: 'seti_123_secret_abc',
    });
  });

  describe('POST /api/stripe/setup-intent', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/stripe/setup-intent', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should return 404 when user not found', async () => {
      mockSelectWhere.mockResolvedValue([]);

      const request = new Request('https://example.com/api/stripe/setup-intent', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should create SetupIntent with existing customer', async () => {
      const request = new Request('https://example.com/api/stripe/setup-intent', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.clientSecret).toBe('seti_123_secret_abc');
      expect(mockStripeCustomersCreate).not.toHaveBeenCalled();
      expect(mockStripeSetupIntentsCreate).toHaveBeenCalledWith({
        customer: 'cus_123',
        payment_method_types: ['card'],
        metadata: { userId: 'user_123' },
      });
    });

    it('should create Stripe customer if user has none', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: null })]);

      const request = new Request('https://example.com/api/stripe/setup-intent', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.clientSecret).toBe('seti_123_secret_abc');
      expect(mockStripeCustomersCreate).toHaveBeenCalledWith({
        email: 'test@example.com',
        name: 'Test User',
        metadata: { userId: 'user_123' },
      });
      expect(mockStripeSetupIntentsCreate).toHaveBeenCalledWith({
        customer: 'cus_new',
        payment_method_types: ['card'],
        metadata: { userId: 'user_123' },
      });
    });

    it('should save new customer ID to database', async () => {
      const frozenDate = new Date('2025-01-15T12:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(frozenDate);

      try {
        mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: null })]);

        const request = new Request('https://example.com/api/stripe/setup-intent', {
          method: 'POST',
        }) as unknown as import('next/server').NextRequest;

        await POST(request);

        expect(mockUpdateSet).toHaveBeenCalledWith({
          stripeCustomerId: 'cus_new',
          updatedAt: frozenDate,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('should handle null user name when creating customer', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: null, name: null })]);

      const request = new Request('https://example.com/api/stripe/setup-intent', {
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

      const request = new Request('https://example.com/api/stripe/setup-intent', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create setup intent');
      expect(mockStripeCustomersDel).toHaveBeenCalledWith('cus_new');
    });

    it('should return 400 on Stripe errors', async () => {
      mockStripeSetupIntentsCreate.mockRejectedValue(new StripeError('Invalid customer'));

      const request = new Request('https://example.com/api/stripe/setup-intent', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid customer');
    });

    it('should return 500 on generic errors', async () => {
      mockStripeSetupIntentsCreate.mockRejectedValue(new Error('Network error'));

      const request = new Request('https://example.com/api/stripe/setup-intent', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create setup intent');
    });

    it('should log audit event on successful setup intent creation', async () => {
      const request = new Request('https://example.com/api/stripe/setup-intent', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      await POST(request);

      expect(auditRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'data.write', userId: 'user_123', resourceType: 'payment_method', resourceId: 'seti_123', details: expect.objectContaining({ action: 'setup_intent' }) })
      );
    });
  });
});
