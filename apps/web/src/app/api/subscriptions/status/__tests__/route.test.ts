import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult } from '@/lib/auth';

// Mock database
const mockSelectWhere = vi.fn();
const mockSelectOrderBy = vi.fn();
const mockSelectLimit = vi.fn();

vi.mock('@pagespace/db', () => {
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: (...args: unknown[]) => mockSelectWhere(...args),
        })),
      })),
    },
    users: {},
    subscriptions: {},
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
    and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
    inArray: vi.fn((field: unknown, values: unknown[]) => ({ field, values, type: 'inArray' })),
    desc: vi.fn((field: unknown) => ({ field, type: 'desc' })),
  };
});

// Mock auth
vi.mock('@/lib/auth/auth-helpers', () => ({
  requireAuth: vi.fn(),
  isAuthError: vi.fn(),
}));

// Import after mocks
import { GET } from '../route';
import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';

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
      expect(body.storage.quota).toBe(2 * 1024 * 1024 * 1024); // 2GB
    });

    it('should return founder tier status with correct quota', async () => {
      mockSelectWhere.mockResolvedValueOnce([mockUser({
        subscriptionTier: 'founder',
        stripeCustomerId: 'cus_123',
      })]);

      mockSelectLimit.mockResolvedValue([mockSubscription({ status: 'active' })]);

      const request = new Request('https://example.com/api/subscriptions/status', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest;

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.subscriptionTier).toBe('founder');
      expect(body.storage.tier).toBe('founder');
      expect(body.storage.quota).toBe(10 * 1024 * 1024 * 1024); // 10GB
    });

    it('should return business tier status with correct quota', async () => {
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
      expect(body.subscriptionTier).toBe('business');
      expect(body.storage.tier).toBe('business');
      expect(body.storage.quota).toBe(50 * 1024 * 1024 * 1024); // 50GB
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

  describe('Storage quota by tier', () => {
    const tierQuotaTests = [
      { tier: 'free', expectedQuota: 500 * 1024 * 1024, description: '500MB' },
      { tier: 'pro', expectedQuota: 2 * 1024 * 1024 * 1024, description: '2GB' },
      { tier: 'founder', expectedQuota: 10 * 1024 * 1024 * 1024, description: '10GB' },
      { tier: 'business', expectedQuota: 50 * 1024 * 1024 * 1024, description: '50GB' },
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
        expect(body.storage.tier).toBe(tier);
      });
    }
  });
});
