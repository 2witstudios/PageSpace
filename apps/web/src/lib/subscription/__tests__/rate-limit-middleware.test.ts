import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock next/server ──────────────────────────────────────────────────────────
vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((body: unknown, init?: ResponseInit) => ({
      body,
      status: (init as { status?: number })?.status ?? 200,
      headers: (init as { headers?: Record<string, string> })?.headers ?? {},
    })),
  },
}));

// ── Mock usage-service ────────────────────────────────────────────────────────
// Path is relative to the source file, not the test file
vi.mock('../usage-service', () => ({
  incrementUsage: vi.fn(),
}));

// ── Mock @pagespace/lib ───────────────────────────────────────────────────────
vi.mock('@pagespace/lib', () => ({
  getTomorrowMidnightUTC: vi.fn(() => Date.now() + 86400000),
  isOnPrem: vi.fn(() => false),
}));

// ── Mock ai-providers-config ──────────────────────────────────────────────────
vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  getPageSpaceModelTier: vi.fn(),
}));

// ── Import under test ─────────────────────────────────────────────────────────
import {
  checkAIRateLimit,
  createRateLimitResponse,
  requiresProSubscription,
  createSubscriptionRequiredResponse,
} from '../rate-limit-middleware';
import { incrementUsage } from '../usage-service';
import { isOnPrem } from '@pagespace/lib';
import { getPageSpaceModelTier } from '@/lib/ai/core/ai-providers-config';
import { NextResponse } from 'next/server';

const mockIncrementUsage = incrementUsage as ReturnType<typeof vi.fn>;
const mockIsOnPrem = isOnPrem as ReturnType<typeof vi.fn>;
const mockGetPageSpaceModelTier = getPageSpaceModelTier as ReturnType<typeof vi.fn>;
const mockNextResponseJson = NextResponse.json as ReturnType<typeof vi.fn>;

describe('rate-limit-middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOnPrem.mockReturnValue(false);
    mockNextResponseJson.mockImplementation((body: unknown, init?: ResponseInit) => ({
      body,
      status: (init as { status?: number })?.status ?? 200,
      headers: (init as { headers?: Record<string, string> })?.headers ?? {},
    }));
  });

  // ── checkAIRateLimit ────────────────────────────────────────────────────────

  describe('checkAIRateLimit', () => {
    it('should return allowed=true when usage is within limit', async () => {
      mockGetPageSpaceModelTier.mockReturnValue('standard');
      mockIncrementUsage.mockResolvedValueOnce({
        success: true,
        remainingCalls: 45,
        limit: 50,
      });

      const result = await checkAIRateLimit('user-1', 'openai');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(45);
      expect(result.limit).toBe(50);
    });

    it('should return allowed=false when limit is exceeded', async () => {
      mockIncrementUsage.mockResolvedValueOnce({
        success: false,
        remainingCalls: 0,
        limit: 50,
      });

      const result = await checkAIRateLimit('user-1', 'openai');

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should use pro providerType when provider is pagespace and model tier is pro', async () => {
      mockGetPageSpaceModelTier.mockReturnValue('pro');
      mockIncrementUsage.mockResolvedValueOnce({
        success: true,
        remainingCalls: 10,
        limit: 50,
      });

      await checkAIRateLimit('user-1', 'pagespace', 'glm-5');

      expect(mockIncrementUsage).toHaveBeenCalledWith('user-1', 'pro');
    });

    it('should use standard providerType when provider is not pagespace', async () => {
      mockGetPageSpaceModelTier.mockReturnValue(null);
      mockIncrementUsage.mockResolvedValueOnce({
        success: true,
        remainingCalls: 30,
        limit: 50,
      });

      await checkAIRateLimit('user-1', 'google', 'gemini');

      expect(mockIncrementUsage).toHaveBeenCalledWith('user-1', 'standard');
    });

    it('should use standard providerType when provider is pagespace but model tier is not pro', async () => {
      mockGetPageSpaceModelTier.mockReturnValue('standard');
      mockIncrementUsage.mockResolvedValueOnce({
        success: true,
        remainingCalls: 30,
        limit: 50,
      });

      await checkAIRateLimit('user-1', 'pagespace', 'glm-4.7');

      expect(mockIncrementUsage).toHaveBeenCalledWith('user-1', 'standard');
    });

    it('should return allowed=false on error', async () => {
      mockIncrementUsage.mockRejectedValueOnce(new Error('Redis unavailable'));

      const result = await checkAIRateLimit('user-1', 'openai');

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.limit).toBe(0);
    });

    it('should return subscriptionTier as unknown', async () => {
      mockIncrementUsage.mockResolvedValueOnce({
        success: true,
        remainingCalls: 10,
        limit: 50,
      });

      const result = await checkAIRateLimit('user-1', 'openai');

      expect(result.subscriptionTier).toBe('unknown');
    });
  });

  // ── createRateLimitResponse ─────────────────────────────────────────────────

  describe('createRateLimitResponse', () => {
    it('should return 429 status response', () => {
      createRateLimitResponse('standard', 50);
      expect(mockNextResponseJson).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Rate limit exceeded' }),
        expect.objectContaining({ status: 429 })
      );
    });

    it('should include standard message for standard providerType', () => {
      createRateLimitResponse('standard', 50);
      const callArgs = mockNextResponseJson.mock.calls[0];
      expect(callArgs[0].message).toContain('Standard AI calls');
    });

    it('should include pro message for pro providerType', () => {
      createRateLimitResponse('pro', 50);
      const callArgs = mockNextResponseJson.mock.calls[0];
      expect(callArgs[0].message).toContain('Pro AI calls');
    });

    it('should include upgradeUrl in response body', () => {
      createRateLimitResponse('standard', 50);
      const callArgs = mockNextResponseJson.mock.calls[0];
      expect(callArgs[0].upgradeUrl).toBe('/settings/billing');
    });

    it('should include X-RateLimit headers', () => {
      createRateLimitResponse('standard', 100);
      const callArgs = mockNextResponseJson.mock.calls[0];
      const headers = callArgs[1].headers;
      expect(headers['X-RateLimit-Limit']).toBe('100');
      expect(headers['X-RateLimit-Remaining']).toBe('0');
    });

    it('should use provided resetTime', () => {
      const resetTime = new Date(Date.now() + 3600000);
      createRateLimitResponse('standard', 50, resetTime);
      const callArgs = mockNextResponseJson.mock.calls[0];
      expect(callArgs[0].resetTime).toBe(resetTime);
    });

    it('should include limit in response body', () => {
      createRateLimitResponse('pro', 75);
      const callArgs = mockNextResponseJson.mock.calls[0];
      expect(callArgs[0].limit).toBe(75);
    });
  });

  // ── requiresProSubscription ─────────────────────────────────────────────────

  describe('requiresProSubscription', () => {
    it('should return false when isOnPrem is true', () => {
      mockIsOnPrem.mockReturnValue(true);
      mockGetPageSpaceModelTier.mockReturnValue('pro');

      const result = requiresProSubscription('pagespace', 'glm-5', 'free');
      expect(result).toBe(false);
    });

    it('should return false when provider is not pagespace', () => {
      const result = requiresProSubscription('google', 'gemini', 'free');
      expect(result).toBe(false);
    });

    it('should return false when model tier is not pro', () => {
      mockGetPageSpaceModelTier.mockReturnValue('standard');
      const result = requiresProSubscription('pagespace', 'glm-4.7', 'free');
      expect(result).toBe(false);
    });

    it('should return false when subscriptionTier is pro', () => {
      mockGetPageSpaceModelTier.mockReturnValue('pro');
      const result = requiresProSubscription('pagespace', 'glm-5', 'pro');
      expect(result).toBe(false);
    });

    it('should return false when subscriptionTier is business', () => {
      mockGetPageSpaceModelTier.mockReturnValue('pro');
      const result = requiresProSubscription('pagespace', 'glm-5', 'business');
      expect(result).toBe(false);
    });

    it('should return true when tier is pro model and subscription is free', () => {
      mockGetPageSpaceModelTier.mockReturnValue('pro');
      const result = requiresProSubscription('pagespace', 'glm-5', 'free');
      expect(result).toBe(true);
    });

    it('should return true when tier is pro model and subscription is undefined', () => {
      mockGetPageSpaceModelTier.mockReturnValue('pro');
      const result = requiresProSubscription('pagespace', 'glm-5', undefined);
      expect(result).toBe(true);
    });

    it('should handle undefined model gracefully', () => {
      const result = requiresProSubscription('pagespace', undefined, 'free');
      expect(result).toBe(false);
    });
  });

  // ── createSubscriptionRequiredResponse ──────────────────────────────────────

  describe('createSubscriptionRequiredResponse', () => {
    it('should return 403 status response', () => {
      createSubscriptionRequiredResponse();
      expect(mockNextResponseJson).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Subscription required' }),
        expect.objectContaining({ status: 403 })
      );
    });

    it('should include upgradeUrl in the response', () => {
      createSubscriptionRequiredResponse();
      const callArgs = mockNextResponseJson.mock.calls[0];
      expect(callArgs[0].upgradeUrl).toBe('/settings/billing');
    });

    it('should include a descriptive message', () => {
      createSubscriptionRequiredResponse();
      const callArgs = mockNextResponseJson.mock.calls[0];
      expect(callArgs[0].message).toBeTruthy();
    });
  });
});
