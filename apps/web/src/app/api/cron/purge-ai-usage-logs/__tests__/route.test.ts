/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for /api/cron/purge-ai-usage-logs
//
// Tests the two-phase approach: anonymize (30d) + purge (90d) of AI usage logs.
// ============================================================================

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  anonymizeAiUsageContent: vi.fn(),
  purgeAiUsageLogs: vi.fn(),
}));

import { GET, POST } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { anonymizeAiUsageContent, purgeAiUsageLogs } from '@pagespace/lib';

// ============================================================================
// GET /api/cron/purge-ai-usage-logs - Contract Tests
// ============================================================================

describe('GET /api/cron/purge-ai-usage-logs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
  });

  describe('authentication', () => {
    it('should return auth error when cron request is invalid', async () => {
      const errorResponse = NextResponse.json(
        { error: 'Forbidden' },
        { status: 403 }
      );
      vi.mocked(validateSignedCronRequest).mockReturnValue(errorResponse);

      const request = new Request('http://localhost/api/cron/purge-ai-usage-logs');
      const response = await GET(request);

      expect(response.status).toBe(403);
    });
  });

  describe('success', () => {
    it('should return anonymized and purged counts', async () => {
      vi.mocked(anonymizeAiUsageContent).mockResolvedValue(10);
      vi.mocked(purgeAiUsageLogs).mockResolvedValue(3);

      const request = new Request('http://localhost/api/cron/purge-ai-usage-logs');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.anonymized).toBe(10);
      expect(body.purged).toBe(3);
      expect(body.timestamp).toBeDefined();
    });

    it('should pass correct date thresholds to anonymize and purge functions', async () => {
      vi.mocked(anonymizeAiUsageContent).mockResolvedValue(0);
      vi.mocked(purgeAiUsageLogs).mockResolvedValue(0);

      const request = new Request('http://localhost/api/cron/purge-ai-usage-logs');
      await GET(request);

      // anonymize should be called with a Date ~30 days ago
      expect(anonymizeAiUsageContent).toHaveBeenCalledWith(expect.any(Date));
      const anonymizeDate = vi.mocked(anonymizeAiUsageContent).mock.calls[0][0] as Date;
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const delta30 = Math.abs(Date.now() - anonymizeDate.getTime() - thirtyDaysMs);
      expect(delta30).toBeLessThan(5000);

      // purge should be called with a Date ~90 days ago
      expect(purgeAiUsageLogs).toHaveBeenCalledWith(expect.any(Date));
      const purgeDate = vi.mocked(purgeAiUsageLogs).mock.calls[0][0] as Date;
      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
      const delta90 = Math.abs(Date.now() - purgeDate.getTime() - ninetyDaysMs);
      expect(delta90).toBeLessThan(5000);
    });

    it('should return 0 counts when nothing to process', async () => {
      vi.mocked(anonymizeAiUsageContent).mockResolvedValue(0);
      vi.mocked(purgeAiUsageLogs).mockResolvedValue(0);

      const request = new Request('http://localhost/api/cron/purge-ai-usage-logs');
      const response = await GET(request);
      const body = await response.json();

      expect(body.anonymized).toBe(0);
      expect(body.purged).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should return 500 when anonymize throws', async () => {
      vi.mocked(anonymizeAiUsageContent).mockRejectedValue(new Error('DB error'));

      const request = new Request('http://localhost/api/cron/purge-ai-usage-logs');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('DB error');
    });

    it('should return 500 when purge throws', async () => {
      vi.mocked(anonymizeAiUsageContent).mockResolvedValue(5);
      vi.mocked(purgeAiUsageLogs).mockRejectedValue(new Error('Purge failed'));

      const request = new Request('http://localhost/api/cron/purge-ai-usage-logs');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Purge failed');
    });

    it('should return "Unknown error" for non-Error throws', async () => {
      vi.mocked(anonymizeAiUsageContent).mockRejectedValue(42);

      const request = new Request('http://localhost/api/cron/purge-ai-usage-logs');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Unknown error');
    });
  });
});

// ============================================================================
// POST /api/cron/purge-ai-usage-logs - Delegates to GET
// ============================================================================

describe('POST /api/cron/purge-ai-usage-logs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
  });

  it('should delegate to GET handler', async () => {
    vi.mocked(anonymizeAiUsageContent).mockResolvedValue(1);
    vi.mocked(purgeAiUsageLogs).mockResolvedValue(2);

    const request = new Request('http://localhost/api/cron/purge-ai-usage-logs', { method: 'POST' });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.anonymized).toBe(1);
    expect(body.purged).toBe(2);
  });
});
