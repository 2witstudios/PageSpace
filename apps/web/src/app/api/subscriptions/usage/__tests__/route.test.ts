/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';

// ============================================================================
// Contract Tests for /api/subscriptions/usage
//
// Tests GET handler for fetching user usage summary.
// Uses requireAuth from auth-helpers instead of authenticateRequestWithOptions.
// ============================================================================

vi.mock('@/lib/auth/auth-helpers', () => ({
  requireAuth: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@/lib/subscription/usage-service', () => ({
  getUserUsageSummary: vi.fn(),
}));

import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { getUserUsageSummary } from '@/lib/subscription/usage-service';

// ============================================================================
// GET /api/subscriptions/usage
// ============================================================================

describe('GET /api/subscriptions/usage', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAuth).mockResolvedValue({
      userId: mockUserId,
      role: 'user',
      tokenVersion: 0,
      tokenType: 'session',
      sessionId: 'test-session',
    });
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      const unauthorizedResponse = new NextResponse('Unauthorized', { status: 401 });
      vi.mocked(requireAuth).mockResolvedValue(unauthorizedResponse);
      vi.mocked(isAuthError).mockReturnValue(true);

      const request = new Request('https://example.com/api/subscriptions/usage');
      const response = await GET(request as any);

      expect(response.status).toBe(401);
    });
  });

  describe('success', () => {
    it('should return usage summary', async () => {
      const usageSummary = {
        aiMessages: { used: 50, limit: 1000, remaining: 950 },
        storage: { used: 500000, limit: 10000000, remaining: 9500000 },
        period: { start: '2024-01-01', end: '2024-01-31' },
      };
      vi.mocked(getUserUsageSummary).mockResolvedValue(usageSummary);

      const request = new Request('https://example.com/api/subscriptions/usage');
      const response = await GET(request as any);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(usageSummary);
      expect(getUserUsageSummary).toHaveBeenCalledWith(mockUserId);
    });
  });

  describe('error handling', () => {
    it('should return 500 when getUserUsageSummary fails', async () => {
      vi.mocked(getUserUsageSummary).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/subscriptions/usage');
      const response = await GET(request as any);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch usage');
    });
  });
});
