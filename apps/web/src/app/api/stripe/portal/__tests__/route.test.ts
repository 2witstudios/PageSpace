import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock Stripe - use vi.hoisted to ensure mocks are available before vi.mock
const {
  mockStripeBillingPortalSessionsCreate,
} = vi.hoisted(() => {
  return {
    mockStripeBillingPortalSessionsCreate: vi.fn(),
  };
});

vi.mock('@/lib/stripe', () => ({
  stripe: {
    billingPortal: {
      sessions: {
        create: mockStripeBillingPortalSessionsCreate,
      },
    },
  },
}));

// Mock database
const mockSelectWhere = vi.fn();

vi.mock('@pagespace/db/db', () => ({
  db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: mockSelectWhere,
        })),
      })),
    },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: {},
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
const mockUser = (overrides: Partial<{
  id: string;
  stripeCustomerId: string | null;
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  stripeCustomerId: 'stripeCustomerId' in overrides ? overrides.stripeCustomerId : 'cus_123',
});

describe('Portal API', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Setup default database response
    mockSelectWhere.mockResolvedValue([mockUser()]);

    // Setup default Stripe mock
    mockStripeBillingPortalSessionsCreate.mockResolvedValue({
      url: 'https://billing.stripe.com/session/test_session',
    });

    // Setup env var
    vi.stubEnv('WEB_APP_URL', 'https://app.example.com');
  });

  describe('POST /api/stripe/portal', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/stripe/portal', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should return 404 when user not found', async () => {
      mockSelectWhere.mockResolvedValue([]);

      const request = new Request('https://example.com/api/stripe/portal', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should return 400 when user has no Stripe customer', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ stripeCustomerId: null })]);

      const request = new Request('https://example.com/api/stripe/portal', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('No Stripe customer found');
    });

    it('should create portal session and return URL', async () => {
      const request = new Request('https://example.com/api/stripe/portal', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.url).toBe('https://billing.stripe.com/session/test_session');
    });

    it('should use correct return URL', async () => {
      const request = new Request('https://example.com/api/stripe/portal', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      await POST(request);

      expect(mockStripeBillingPortalSessionsCreate).toHaveBeenCalledWith({
        customer: 'cus_123',
        return_url: 'https://app.example.com/settings/billing',
      });
    });

    it('should return 500 on errors', async () => {
      mockStripeBillingPortalSessionsCreate.mockRejectedValue(new Error('Stripe error'));

      const request = new Request('https://example.com/api/stripe/portal', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create portal session');
    });

    it('should log audit event on POST portal session', async () => {
      const request = new Request('https://example.com/api/stripe/portal', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      await POST(request);

      expect(auditRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'data.read', userId: 'user_123', resourceType: 'billing_portal', resourceId: 'portal_session' })
      );
    });

    it('should not include customerId in audit details (GDPR: details field is in hash chain)', async () => {
      const request = new Request('https://example.com/api/stripe/portal', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest;

      await POST(request);

      const eventArg = vi.mocked(auditRequest).mock.calls[0]?.[1];
      expect(eventArg?.details).not.toHaveProperty('customerId');
    });
  });
});
