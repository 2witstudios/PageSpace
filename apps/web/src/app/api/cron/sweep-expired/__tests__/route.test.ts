/**
 * Contract tests for /api/cron/sweep-expired.
 *
 * Verifies auth, independent per-table sweep, and that audit logging
 * captures the combined result (success OR partial failure).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockSweepJTI,
  mockSweepRateLimit,
  mockSweepAuthHandoff,
  mockSweepPendingAbortIntents,
  mockSweepPendingUploads,
  mockAudit,
} = vi.hoisted(() => ({
  mockSweepJTI: vi.fn(),
  mockSweepRateLimit: vi.fn(),
  mockSweepAuthHandoff: vi.fn(),
  mockSweepPendingAbortIntents: vi.fn(),
  mockSweepPendingUploads: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/security/jti-revocation', () => ({
  sweepExpiredRevokedJTIs: mockSweepJTI,
}));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  sweepExpiredRateLimitBuckets: mockSweepRateLimit,
}));
vi.mock('@pagespace/lib/security/auth-handoff-sweep', () => ({
  sweepExpiredAuthHandoffTokens: mockSweepAuthHandoff,
}));
vi.mock('@/lib/ai/core/pending-abort-intents', () => ({
  sweepExpiredPendingAbortIntents: mockSweepPendingAbortIntents,
}));
vi.mock('@pagespace/lib/services/pending-uploads', () => ({
  sweepExpiredPendingUploads: mockSweepPendingUploads,
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
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
    mockSweepAuthHandoff.mockResolvedValue(0);
    mockSweepPendingAbortIntents.mockResolvedValue(0);
    mockSweepPendingUploads.mockResolvedValue(0);
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
      expect(mockSweepAuthHandoff).not.toHaveBeenCalled();
      expect(mockSweepPendingAbortIntents).not.toHaveBeenCalled();
      expect(mockSweepPendingUploads).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('sweeps all five tables and reports counts in results', async () => {
      mockSweepJTI.mockResolvedValue(7);
      mockSweepRateLimit.mockResolvedValue(42);
      mockSweepAuthHandoff.mockResolvedValue(13);
      mockSweepPendingAbortIntents.mockResolvedValue(2);
      mockSweepPendingUploads.mockResolvedValue(4);

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
      expect(body.results.authHandoffTokens).toBe(13);
      expect(body.results.pendingAbortIntents).toBe(2);
      expect(body.results.pendingUploads).toBe(4);
      expect(body.timestamp).toEqual(expect.any(String));
    });

    it('emits exactly one audit event containing all five counts', async () => {
      mockSweepJTI.mockResolvedValue(3);
      mockSweepRateLimit.mockResolvedValue(11);
      mockSweepAuthHandoff.mockResolvedValue(5);
      mockSweepPendingAbortIntents.mockResolvedValue(1);
      mockSweepPendingUploads.mockResolvedValue(9);

      await GET(makeRequest());

      expect(mockAudit).toHaveBeenCalledTimes(1);
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'data.delete',
          resourceType: 'cron_job',
          resourceId: 'sweep_expired',
          details: {
            revokedServiceTokens: 3,
            rateLimitBuckets: 11,
            authHandoffTokens: 5,
            pendingAbortIntents: 1,
            pendingUploads: 9,
          },
        }),
      );
    });
  });

  describe('partial failure (one table throws)', () => {
    it('returns 500 when only the auth-handoff sweep fails, still records the others and audits', async () => {
      mockSweepJTI.mockResolvedValue(5);
      mockSweepRateLimit.mockResolvedValue(9);
      mockSweepAuthHandoff.mockRejectedValue(new Error('handoff-table down'));
      mockSweepPendingAbortIntents.mockResolvedValue(0);

      const res = await GET(makeRequest());
      const body = (await res.json()) as {
        success: boolean;
        results: Record<string, number | { error: string }>;
      };

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.results.revokedServiceTokens).toBe(5);
      expect(body.results.rateLimitBuckets).toBe(9);
      expect(body.results.authHandoffTokens).toEqual({
        error: 'handoff-table down',
      });
      expect(body.results.pendingAbortIntents).toBe(0);
      expect(mockAudit).toHaveBeenCalledTimes(1);
    });

    it('continues sweeping subsequent tables after an earlier one throws (error isolation)', async () => {
      mockSweepJTI.mockRejectedValue(new Error('jti-table unavailable'));
      mockSweepRateLimit.mockResolvedValue(4);
      mockSweepAuthHandoff.mockResolvedValue(2);
      mockSweepPendingAbortIntents.mockResolvedValue(6);

      const res = await GET(makeRequest());
      const body = (await res.json()) as {
        results: Record<string, number | { error: string }>;
      };

      expect(res.status).toBe(500);
      expect(mockSweepRateLimit).toHaveBeenCalledTimes(1);
      expect(mockSweepAuthHandoff).toHaveBeenCalledTimes(1);
      expect(mockSweepPendingAbortIntents).toHaveBeenCalledTimes(1);
      expect(body.results.rateLimitBuckets).toBe(4);
      expect(body.results.authHandoffTokens).toBe(2);
      expect(body.results.pendingAbortIntents).toBe(6);
      expect(body.results.revokedServiceTokens).toEqual({
        error: 'jti-table unavailable',
      });
    });

    it('returns 500 when only the pending-abort-intent sweep fails, still records the others and audits', async () => {
      mockSweepJTI.mockResolvedValue(5);
      mockSweepRateLimit.mockResolvedValue(9);
      mockSweepAuthHandoff.mockResolvedValue(4);
      mockSweepPendingAbortIntents.mockRejectedValue(new Error('pending-abort-table down'));

      const res = await GET(makeRequest());
      const body = (await res.json()) as {
        success: boolean;
        results: Record<string, number | { error: string }>;
      };

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.results.pendingAbortIntents).toEqual({
        error: 'pending-abort-table down',
      });
      expect(mockAudit).toHaveBeenCalledTimes(1);
    });

    it('returns 500 when only the pending-uploads sweep fails, still records the others and audits', async () => {
      mockSweepJTI.mockResolvedValue(5);
      mockSweepRateLimit.mockResolvedValue(9);
      mockSweepAuthHandoff.mockResolvedValue(4);
      mockSweepPendingUploads.mockRejectedValue(new Error('pending-uploads-table down'));

      const res = await GET(makeRequest());
      const body = (await res.json()) as {
        success: boolean;
        results: Record<string, number | { error: string }>;
      };

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.results.pendingUploads).toEqual({
        error: 'pending-uploads-table down',
      });
      expect(mockAudit).toHaveBeenCalledTimes(1);
    });
  });

  describe('full failure (all tables throw)', () => {
    it('returns 500 with every error recorded, still emits audit', async () => {
      mockSweepJTI.mockRejectedValue(new Error('jti down'));
      mockSweepRateLimit.mockRejectedValue(new Error('rate-limit down'));
      mockSweepAuthHandoff.mockRejectedValue(new Error('handoff down'));
      mockSweepPendingAbortIntents.mockRejectedValue(new Error('pending-abort down'));
      mockSweepPendingUploads.mockRejectedValue(new Error('pending-uploads down'));

      const res = await GET(makeRequest());
      const body = (await res.json()) as {
        success: boolean;
        results: Record<string, { error: string }>;
      };

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.results.revokedServiceTokens).toEqual({ error: 'jti down' });
      expect(body.results.rateLimitBuckets).toEqual({ error: 'rate-limit down' });
      expect(body.results.authHandoffTokens).toEqual({ error: 'handoff down' });
      expect(body.results.pendingAbortIntents).toEqual({ error: 'pending-abort down' });
      expect(body.results.pendingUploads).toEqual({ error: 'pending-uploads down' });
      expect(mockAudit).toHaveBeenCalledTimes(1);
    });
  });
});
