import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult } from '@/lib/auth';

// Mock database
const mockSelectWhere = vi.fn();
const mockSelectOrderBy = vi.fn();
const mockSelectLimit = vi.fn();

vi.mock('@pagespace/db/db', () => ({
  db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: (...args: unknown[]) => mockSelectWhere(...args),
        })),
      })),
    },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  inArray: vi.fn((field: unknown, values: unknown[]) => ({ field, values, type: 'inArray' })),
  desc: vi.fn((field: unknown) => ({ field, type: 'desc' })),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: {},
}));
vi.mock('@pagespace/db/schema/subscriptions', () => ({
  subscriptions: {},
}));

// Mock auth
vi.mock('@/lib/auth/auth-helpers', () => ({
  requireAuth: vi.fn(),
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
// The App Store mirror read (lib billing/apple): none unless a test sets one.
const mockLatestAppleSubscription = vi.hoisted(() => vi.fn());
const mockHasRenewableAppleSubscription = vi.hoisted(() => vi.fn());
const mockAppleEntitledTier = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/lib/billing/apple/apple-entitlement', () => ({
  latestAppleSubscription: mockLatestAppleSubscription,
  appleEntitledTier: mockAppleEntitledTier,
  hasRenewableAppleSubscription: mockHasRenewableAppleSubscription,
}));
vi.mock('@/lib/stripe/price-config', () => ({
  getPersonalTierFromPrice: (priceId: string) => (priceId === 'price_pro' ? 'pro' : 'free'),
}));

// Import after mocks
import { GET } from '../route';
import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
// Real, unmocked: money-model is pure (no IO), and mocking it would defeat the planCredits test.
import { tierAllowanceCents } from '@pagespace/lib/billing/money-model';
import { TIERS } from '@pagespace/lib/billing/subscription-tiers';

// Helper to create mock SessionAuthResult
const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

// Helper to create mock user
const mockUser = (overrides: Partial<{
  id: string;
  subscriptionTier: string;
  stripeCustomerId: string | null;
  storageUsedBytes: number;
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  subscriptionTier: overrides.subscriptionTier ?? 'free',
  stripeCustomerId: 'stripeCustomerId' in overrides ? overrides.stripeCustomerId : null,
  storageUsedBytes: overrides.storageUsedBytes ?? 0,
});

// Helper to create mock subscription
const mockSubscription = (overrides: Partial<{
  id: string;
  userId: string;
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}> = {}) => ({
  id: overrides.id ?? 'sub_123',
  userId: overrides.userId ?? 'user_123',
  status: overrides.status ?? 'active',
  currentPeriodStart: overrides.currentPeriodStart ?? new Date('2024-01-01'),
  currentPeriodEnd: overrides.currentPeriodEnd ?? new Date('2024-02-01'),
  cancelAtPeriodEnd: overrides.cancelAtPeriodEnd ?? false,
  stripePriceId: 'price_pro',
});

describe('GET /api/subscriptions/status', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default auth success
    vi.mocked(requireAuth).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    mockSelectWhere.mockReset();
    mockSelectOrderBy.mockReset();
    mockSelectLimit.mockReset();

    // Default: user lookup returns array, subscription lookup returns query builder chain
    mockSelectOrderBy.mockImplementation(() => ({
      limit: mockSelectLimit,
    }));
    mockSelectWhere.mockImplementation(() => ({
      orderBy: mockSelectOrderBy,
    }));
    mockSelectLimit.mockResolvedValue([]);
    mockLatestAppleSubscription.mockReset();
    mockLatestAppleSubscription.mockResolvedValue(null);
    mockHasRenewableAppleSubscription.mockReset();
    mockHasRenewableAppleSubscription.mockResolvedValue(false);
    mockAppleEntitledTier.mockReset();
    mockAppleEntitledTier.mockResolvedValue('free');
  });

  describe('which store sells the plan', () => {
    const request = () => new Request('https://example.com/api/subscriptions/status', { method: 'GET' }) as unknown as import('next/server').NextRequest;

    it('is null for a free user with no purchase anywhere', async () => {
      mockSelectWhere.mockResolvedValueOnce([mockUser()]);
      const body = await (await GET(request())).json();
      expect(body.billingProvider).toBeNull();
      expect(body.appStore).toBeNull();
    });

    it('is stripe for an active Stripe Pro subscription', async () => {
      mockSelectWhere.mockResolvedValueOnce([mockUser({ subscriptionTier: 'pro', stripeCustomerId: 'cus_123' })]);
      mockSelectLimit.mockResolvedValue([mockSubscription({ status: 'active' })]);
      expect((await (await GET(request())).json()).billingProvider).toBe('stripe');
    });

    it('is stripe for a past-due Stripe subscription: it still collects and resumes, so iOS must not sell a second plan', async () => {
      mockSelectWhere.mockResolvedValueOnce([mockUser({ subscriptionTier: 'free', stripeCustomerId: 'cus_123' })]);
      mockSelectLimit.mockResolvedValue([mockSubscription({ status: 'past_due' })]);
      expect((await (await GET(request())).json()).billingProvider).toBe('stripe');
    });

    it('is apple while Apple retries a failed renewal, though the plan no longer entitles', async () => {
      mockSelectWhere.mockResolvedValueOnce([mockUser({ subscriptionTier: 'free' })]);
      mockHasRenewableAppleSubscription.mockResolvedValue(true);
      expect((await (await GET(request())).json()).billingProvider).toBe('apple');
    });

    it('is apple for an entitled App Store subscription, and reports it', async () => {
      const expiresAt = new Date(Date.now() + 86_400_000);
      mockSelectWhere.mockResolvedValueOnce([mockUser({ subscriptionTier: 'pro' })]);
      mockLatestAppleSubscription.mockResolvedValue({ status: 'active', productId: 'ai.pagespace.ios.pro.monthly', expiresAt, autoRenew: true, environment: 'Production' });
      mockAppleEntitledTier.mockResolvedValue('pro');
      const body = await (await GET(request())).json();
      expect(body.billingProvider).toBe('apple');
      expect(mockAppleEntitledTier).toHaveBeenCalledWith(expect.anything(), 'user_123', expect.any(Date));
      expect(body.appStore).toEqual({ status: 'active', productId: 'ai.pagespace.ios.pro.monthly', expiresAt: expiresAt.toISOString(), autoRenew: true, environment: 'Production' });
    });

    it('reports an App Store subscription Apple will still charge, even when Stripe sells the current plan', async () => {
      mockSelectWhere.mockResolvedValueOnce([mockUser({ subscriptionTier: 'pro', stripeCustomerId: 'cus_123' })]);
      mockSelectLimit.mockResolvedValue([mockSubscription({ status: 'active' })]);
      mockHasRenewableAppleSubscription.mockResolvedValue(true);
      const body = await (await GET(request())).json();
      expect(body.billingProvider).toBe('stripe');
      expect(body.appStoreRenews).toBe(true);
      expect(mockHasRenewableAppleSubscription).toHaveBeenCalledWith(expect.anything(), 'user_123', expect.any(Date), { autoRenewing: true });
    });

    it('is not apple once the App Store period has ended', async () => {
      mockSelectWhere.mockResolvedValueOnce([mockUser()]);
      mockLatestAppleSubscription.mockResolvedValue({ status: 'active', productId: 'ai.pagespace.ios.pro.monthly', expiresAt: new Date(Date.now() - 1000), autoRenew: false, environment: 'Production' });
      const body = await (await GET(request())).json();
      expect(body.billingProvider).toBeNull();
      expect(body.appStore).toMatchObject({ status: 'active', autoRenew: false });
    });

    it('is apple when another App Store row entitles, even if the latest-expiring row does not', async () => {
      mockSelectWhere.mockResolvedValueOnce([mockUser({ subscriptionTier: 'pro' })]);
      mockLatestAppleSubscription.mockResolvedValue({ status: 'revoked', productId: 'ai.pagespace.ios.pro.monthly', expiresAt: new Date(Date.now() + 86_400_000), autoRenew: false, environment: 'Production' });
      mockAppleEntitledTier.mockResolvedValue('pro');
      expect((await (await GET(request())).json()).billingProvider).toBe('apple');
    });
  });

  describe('Free tier user', () => {
    it('should return free tier status for user without subscription', async () => {
      mockSelectWhere.mockResolvedValueOnce([mockUser()]);

      const request = new Request('https://example.com/api/subscriptions/status', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.subscriptionTier).toBe('free');
      expect(body.subscription).toBeNull();
      expect(body.storage.tier).toBe('free');
      expect(body.storage.quota).toBe(500 * 1024 * 1024); // 500MB
    });

    it('should return storage usage for free user', async () => {
      const usedBytes = 100 * 1024 * 1024; // 100MB
      mockSelectWhere.mockResolvedValueOnce([mockUser({ storageUsedBytes: usedBytes })]);

      const request = new Request('https://example.com/api/subscriptions/status', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.storage.used).toBe(usedBytes);
    });
  });

  describe('Paid tier user', () => {
    it('should return pro tier status with subscription details', async () => {
      const periodStart = new Date('2024-01-01');
      const periodEnd = new Date('2024-02-01');

      // First call returns user
      mockSelectWhere.mockResolvedValueOnce([mockUser({
        subscriptionTier: 'pro',
        stripeCustomerId: 'cus_123',
      })]);

      // Second call returns subscription
      mockSelectLimit.mockResolvedValue([mockSubscription({
        status: 'active',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      })]);

      const request = new Request('https://example.com/api/subscriptions/status', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.subscriptionTier).toBe('pro');
      expect(body.stripeCustomerId).toBe('cus_123');
      expect(body.subscription).toEqual({
        status: 'active',
        currentPeriodStart: periodStart.toISOString(),
        currentPeriodEnd: periodEnd.toISOString(),
        cancelAtPeriodEnd: false,
      });
      expect(body.storage.tier).toBe('pro');
      expect(body.storage.quota).toBe(10 * 1024 * 1024 * 1024); // 10GB
    });

    it('A-9 refuses a retired personal Business tier and omits grandfathering', async () => {
      mockSelectWhere.mockResolvedValueOnce([mockUser({
        subscriptionTier: 'business',
        stripeCustomerId: 'cus_123',
      })]);

      mockSelectLimit.mockResolvedValue([mockSubscription({ status: 'active' })]);

      const request = new Request('https://example.com/api/subscriptions/status', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.subscriptionTier).toBe('free');
      expect(body).not.toHaveProperty('subscriptionGrandfathered');
      expect(body.storage.tier).toBe('free');
      expect(body.storage.quota).toBe(500 * 1024 * 1024);
    });

    it('should include cancelAtPeriodEnd status', async () => {
      mockSelectWhere.mockResolvedValueOnce([mockUser({
        subscriptionTier: 'pro',
        stripeCustomerId: 'cus_123',
      })]);

      mockSelectLimit.mockResolvedValue([mockSubscription({
        status: 'active',
        cancelAtPeriodEnd: true,
      })]);

      const request = new Request('https://example.com/api/subscriptions/status', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(body.subscription.cancelAtPeriodEnd).toBe(true);
    });
  });

  describe('Tier coercion', () => {
    it.each([null, '', 'enterprise-legacy'])(
      'should coerce a stored tier of %j to free instead of passing it through',
      async (stored) => {
        mockSelectWhere.mockResolvedValueOnce([
          { ...mockUser(), subscriptionTier: stored as unknown as string },
        ]);

        const request = new Request('https://example.com/api/subscriptions/status', {
          method: 'GET',
        }) as unknown as import('next/server').NextRequest;

        const response = await GET(request);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.subscriptionTier).toBe('free');
        expect(body.storage.tier).toBe('free');
      },
    );
  });

  describe('Error handling', () => {
    it('should return 404 when user not found', async () => {
      mockSelectWhere.mockResolvedValueOnce([]);

      const request = new Request('https://example.com/api/subscriptions/status', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should return auth error when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(requireAuth).mockResolvedValue(
        NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      );

      const request = new Request('https://example.com/api/subscriptions/status', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('User without stripeCustomerId', () => {
    it('should not fetch subscription when no stripeCustomerId', async () => {
      mockSelectWhere.mockResolvedValueOnce([mockUser({
        subscriptionTier: 'free',
        stripeCustomerId: null,
      })]);

      const request = new Request('https://example.com/api/subscriptions/status', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.subscription).toBeNull();
      expect(body.stripeCustomerId).toBeNull();
      // mockSelectLimit should NOT have been called for subscription lookup
      expect(mockSelectLimit).not.toHaveBeenCalled();
    });
  });

  describe('Audit logging', () => {
    it('should log audit event on GET subscription status', async () => {
      mockSelectWhere.mockResolvedValueOnce([mockUser()]);

      const request = new Request('https://example.com/api/subscriptions/status', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      await GET(request);

      expect(auditRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'data.read', userId: 'user_123', resourceType: 'subscription_status', resourceId: 'self' })
      );
    });
  });

  describe('MON-2 planCredits', () => {
    it('returns the server-derived included-credit figure per tier, matching tierAllowanceCents (A-11: Pro 900)', async () => {
      mockSelectWhere.mockResolvedValueOnce([mockUser()]);

      const request = new Request('https://example.com/api/subscriptions/status', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.planCredits).toEqual(
        Object.fromEntries(TIERS.map((tier) => [tier, tierAllowanceCents(tier)])),
      );
      // Pinned: A-11's 60% of list price (free = starter grant).
      expect(body.planCredits).toEqual({ free: 500, pro: 900, business: 3000 });
    });
  });

  describe('Storage quota by tier', () => {
    const tierQuotaTests = [
      { tier: 'free', expectedQuota: 500 * 1024 * 1024, description: '500MB' },
      { tier: 'pro', expectedQuota: 10 * 1024 * 1024 * 1024, description: '10GB' },
      { tier: 'business', expectedQuota: 500 * 1024 * 1024, description: 'Free fallback for retired personal Business' },
    ];

    for (const { tier, expectedQuota, description } of tierQuotaTests) {
      it(`should return ${description} quota for ${tier} tier`, async () => {
        mockSelectWhere.mockResolvedValueOnce([mockUser({
          subscriptionTier: tier,
          stripeCustomerId: tier !== 'free' ? 'cus_123' : null,
        })]);

        if (tier !== 'free') {
          mockSelectLimit.mockResolvedValue([mockSubscription({ status: 'active' })]);
        }

        const request = new Request('https://example.com/api/subscriptions/status', {
          method: 'GET',
        }) as unknown as import('next/server').NextRequest;

        const response = await GET(request);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.storage.quota).toBe(expectedQuota);
        expect(body.storage.tier).toBe(tier === 'business' ? 'free' : tier);
      });
    }
  });
});
