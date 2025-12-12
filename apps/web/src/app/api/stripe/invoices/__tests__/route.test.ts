import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock Stripe - use vi.hoisted to ensure mocks are available before vi.mock
const {
  mockStripeInvoicesList,
  StripeError,
} = vi.hoisted(() => {
  const StripeError = class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'StripeError';
    }
  };
  return {
    mockStripeInvoicesList: vi.fn(),
    StripeError,
  };
});

vi.mock('@/lib/stripe', () => ({
  stripe: {
    invoices: {
      list: mockStripeInvoicesList,
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
import { GET } from '../route';
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
  stripeCustomerId: string | null;
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  stripeCustomerId: 'stripeCustomerId' in overrides ? overrides.stripeCustomerId : 'cus_123',
});

// Helper to create mock Stripe invoice
const mockInvoice = (overrides: Partial<{
  id: string;
  number: string | null;
  status: string;
  amount_due: number;
  amount_paid: number;
  currency: string;
  created: number;
  period_start: number | null;
  period_end: number | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  description: string | null;
}> = {}) => ({
  id: overrides.id ?? 'in_123',
  number: overrides.number ?? 'INV-0001',
  status: overrides.status ?? 'paid',
  amount_due: overrides.amount_due ?? 1500,
  amount_paid: overrides.amount_paid ?? 1500,
  currency: overrides.currency ?? 'usd',
  created: overrides.created ?? 1700000000,
  period_start: 'period_start' in overrides ? overrides.period_start : 1699000000,
  period_end: 'period_end' in overrides ? overrides.period_end : 1701592000,
  hosted_invoice_url: overrides.hosted_invoice_url ?? 'https://invoice.stripe.com/i/test',
  invoice_pdf: overrides.invoice_pdf ?? 'https://invoice.stripe.com/pdf/test',
  description: overrides.description ?? null,
  lines: {
    data: [{ description: 'Pro Plan Subscription' }],
  },
});

describe('Invoices API', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Setup default database response
    mockSelectWhere.mockResolvedValue([mockUser()]);

    // Setup default Stripe mock
    mockStripeInvoicesList.mockResolvedValue({
      data: [mockInvoice()],
      has_more: false,
    });
  });

  describe('GET /api/stripe/invoices', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/stripe/invoices', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should return 404 when user not found', async () => {
      mockSelectWhere.mockResolvedValue([]);

      const request = new Request('https://example.com/api/stripe/invoices', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should return empty invoices when user has no Stripe customer', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: null })]);

      const request = new Request('https://example.com/api/stripe/invoices', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.invoices).toEqual([]);
      expect(body.hasMore).toBe(false);
    });

    it('should list invoices successfully with all fields mapped', async () => {
      const request = new Request('https://example.com/api/stripe/invoices', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.invoices).toHaveLength(1);
      expect(body.invoices[0]).toEqual({
        id: 'in_123',
        number: 'INV-0001',
        status: 'paid',
        amountDue: 1500,
        amountPaid: 1500,
        currency: 'usd',
        created: expect.any(String),
        periodStart: expect.any(String),
        periodEnd: expect.any(String),
        hostedInvoiceUrl: 'https://invoice.stripe.com/i/test',
        invoicePdf: 'https://invoice.stripe.com/pdf/test',
        description: 'Pro Plan Subscription',
      });
      expect(body.hasMore).toBe(false);
    });

    it('should use invoice description if present', async () => {
      mockStripeInvoicesList.mockResolvedValue({
        data: [mockInvoice({ description: 'Custom Description' })],
        has_more: false,
      });

      const request = new Request('https://example.com/api/stripe/invoices', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(body.invoices[0].description).toBe('Custom Description');
    });

    it('should pass pagination params to Stripe', async () => {
      const request = new Request('https://example.com/api/stripe/invoices?limit=5&starting_after=in_prev', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      await GET(request);

      expect(mockStripeInvoicesList).toHaveBeenCalledWith({
        customer: 'cus_123',
        limit: 5,
        starting_after: 'in_prev',
      });
    });

    it('should cap limit at 100', async () => {
      const request = new Request('https://example.com/api/stripe/invoices?limit=200', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      await GET(request);

      expect(mockStripeInvoicesList).toHaveBeenCalledWith({
        customer: 'cus_123',
        limit: 100,
        starting_after: undefined,
      });
    });

    it('should default limit to 10', async () => {
      const request = new Request('https://example.com/api/stripe/invoices', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      await GET(request);

      expect(mockStripeInvoicesList).toHaveBeenCalledWith({
        customer: 'cus_123',
        limit: 10,
        starting_after: undefined,
      });
    });

    it('should return hasMore when more invoices exist', async () => {
      mockStripeInvoicesList.mockResolvedValue({
        data: [mockInvoice()],
        has_more: true,
      });

      const request = new Request('https://example.com/api/stripe/invoices', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(body.hasMore).toBe(true);
    });

    it('should handle null period dates', async () => {
      mockStripeInvoicesList.mockResolvedValue({
        data: [mockInvoice({ period_start: null, period_end: null })],
        has_more: false,
      });

      const request = new Request('https://example.com/api/stripe/invoices', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(body.invoices[0].periodStart).toBeNull();
      expect(body.invoices[0].periodEnd).toBeNull();
    });

    it('should return 400 on Stripe errors', async () => {
      mockStripeInvoicesList.mockRejectedValue(new StripeError('Invalid customer'));

      const request = new Request('https://example.com/api/stripe/invoices', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid customer');
    });

    it('should return 500 on generic errors', async () => {
      mockStripeInvoicesList.mockRejectedValue(new Error('Database connection failed'));

      const request = new Request('https://example.com/api/stripe/invoices', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to list invoices');
    });
  });
});
