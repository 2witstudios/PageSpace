/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for /api/cron/cleanup-tokens
//
// Tests the route handler's contract for cleaning up expired device tokens.
// ============================================================================

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  cleanupExpiredDeviceTokens: vi.fn(),
}));

import { GET, POST } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { cleanupExpiredDeviceTokens } from '@pagespace/lib';

// ============================================================================
// GET /api/cron/cleanup-tokens - Contract Tests
// ============================================================================

describe('GET /api/cron/cleanup-tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
  });

  describe('authentication', () => {
    it('should return auth error when cron request is invalid', async () => {
      const errorResponse = NextResponse.json(
        { error: 'Forbidden - missing cron authentication headers' },
        { status: 403 }
      );
      vi.mocked(validateSignedCronRequest).mockReturnValue(errorResponse);

      const request = new Request('http://localhost/api/cron/cleanup-tokens');
      const response = await GET(request);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain('Forbidden');
    });
  });

  describe('success', () => {
    it('should return success with cleanup count', async () => {
      vi.mocked(cleanupExpiredDeviceTokens).mockResolvedValue(5);

      const request = new Request('http://localhost/api/cron/cleanup-tokens');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.cleanedUp).toBe(5);
      expect(body.timestamp).toBeDefined();
    });

    it('should return success with 0 when no tokens expired', async () => {
      vi.mocked(cleanupExpiredDeviceTokens).mockResolvedValue(0);

      const request = new Request('http://localhost/api/cron/cleanup-tokens');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.cleanedUp).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should return 500 when cleanup throws an Error', async () => {
      vi.mocked(cleanupExpiredDeviceTokens).mockRejectedValue(new Error('DB connection lost'));

      const request = new Request('http://localhost/api/cron/cleanup-tokens');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('DB connection lost');
    });

    it('should return "Unknown error" for non-Error throws', async () => {
      vi.mocked(cleanupExpiredDeviceTokens).mockRejectedValue('string error');

      const request = new Request('http://localhost/api/cron/cleanup-tokens');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Unknown error');
    });
  });
});

// ============================================================================
// POST /api/cron/cleanup-tokens - Delegates to GET
// ============================================================================

describe('POST /api/cron/cleanup-tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
  });

  it('should delegate to GET handler and return same result', async () => {
    vi.mocked(cleanupExpiredDeviceTokens).mockResolvedValue(3);

    const request = new Request('http://localhost/api/cron/cleanup-tokens', { method: 'POST' });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.cleanedUp).toBe(3);
  });
});
