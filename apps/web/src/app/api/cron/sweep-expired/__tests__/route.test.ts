/**
 * Contract tests for /api/cron/sweep-expired.
 *
 * Verifies auth, independent per-table sweep, and that audit logging
 * captures the combined result (success OR partial failure).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSweepJTI, mockSweepRateLimit, mockAudit } = vi.hoisted(() => ({
  mockSweepJTI: vi.fn(),
  mockSweepRateLimit: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/security', () => ({
  sweepExpiredRevokedJTIs: mockSweepJTI,
  sweepExpiredRateLimitBuckets: mockSweepRateLimit,
}));

vi.mock('@pagespace/lib/server', () => ({
  audit: mockAudit,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

import { GET } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

function makeRequest(): Request {
  return new Request('http://localhost:3000/api/cron/sweep-expired');
}

describe('/api/cron/sweep-expired', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockSweepJTI.mockResolvedValue(0);
    mockSweepRateLimit.mockResolvedValue(0);
  });

  describe('auth', () => {
    it('short-circuits before any sweep or audit when auth fails', async () => {
      const authResponse = new Response(
        JSON.stringify({ error: 'Forbidden' }),
        { status: 403 },
      );
      vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

      await GET(makeRequest());

      expect(mockSweepJTI).not.toHaveBeenCalled();
      expect(mockSweepRateLimit).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('sweeps both tables and reports counts in results', async () => {
      mockSweepJTI.mockResolvedValue(7);
      mockSweepRateLimit.mockResolvedValue(42);

      const res = await GET(makeRequest());
      const body = (await res.json()) as {
        success: boolean;
        results: Record<string, number>;
        timestamp: string;
      };

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.results.revokedServiceTokens).toBe(7);
      expect(body.results.rateLimitBuckets).toBe(42);
      expect(body.timestamp).toEqual(expect.any(String));
    });

    it('emits exactly one audit event containing both counts', async () => {
      mockSweepJTI.mockResolvedValue(3);
      mockSweepRateLimit.mockResolvedValue(11);

      await GET(makeRequest());

      expect(mockAudit).toHaveBeenCalledTimes(1);
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'data.delete',
          userId: 'system',
          resourceType: 'cron_job',
          resourceId: 'sweep_expired',
          details: { revokedServiceTokens: 3, rateLimitBuckets: 11 },
        }),
      );
    });
  });

  describe('partial failure (one table throws)', () => {
    it('returns 500 with the error recorded in results, still emits audit', async () => {
      mockSweepJTI.mockResolvedValue(5);
      mockSweepRateLimit.mockRejectedValue(new Error('connection refused'));

      const res = await GET(makeRequest());
      const body = (await res.json()) as {
        success: boolean;
        results: Record<string, number | { error: string }>;
      };

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.results.revokedServiceTokens).toBe(5);
      expect(body.results.rateLimitBuckets).toEqual({ error: 'connection refused' });
      expect(mockAudit).toHaveBeenCalledTimes(1);
    });

    it('continues sweeping the second table after the first throws (error isolation)', async () => {
      mockSweepJTI.mockRejectedValue(new Error('jti-table unavailable'));
      mockSweepRateLimit.mockResolvedValue(4);

      const res = await GET(makeRequest());
      const body = (await res.json()) as {
        results: Record<string, number | { error: string }>;
      };

      expect(res.status).toBe(500);
      expect(mockSweepRateLimit).toHaveBeenCalledTimes(1);
      expect(body.results.rateLimitBuckets).toBe(4);
      expect(body.results.revokedServiceTokens).toEqual({
        error: 'jti-table unavailable',
      });
    });
  });

  describe('full failure (both tables throw)', () => {
    it('returns 500 with both errors recorded, still emits audit', async () => {
      mockSweepJTI.mockRejectedValue(new Error('jti down'));
      mockSweepRateLimit.mockRejectedValue(new Error('rate-limit down'));

      const res = await GET(makeRequest());
      const body = (await res.json()) as {
        success: boolean;
        results: Record<string, { error: string }>;
      };

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.results.revokedServiceTokens).toEqual({ error: 'jti down' });
      expect(body.results.rateLimitBuckets).toEqual({ error: 'rate-limit down' });
      expect(mockAudit).toHaveBeenCalledTimes(1);
    });
  });
});
