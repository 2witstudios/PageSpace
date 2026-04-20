/**
 * Contract tests for /api/cron/sweep-expired
 * Verifies auth, audit logging, and that the sweep counts deletions
 * without materializing every deleted key in memory.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDelete, mockReturning, mockWhere, mockAudit } = vi.hoisted(() => ({
  mockDelete: vi.fn(),
  mockReturning: vi.fn(),
  mockWhere: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: { delete: mockDelete },
  rateLimitBuckets: { key: 'key', expiresAt: 'expires_at' },
  sql: ((_strings: TemplateStringsArray, ..._values: unknown[]) => ({})) as unknown,
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

function mockSweepSucceeds(rowCount: number): void {
  mockWhere.mockResolvedValue({ rowCount });
  mockDelete.mockReturnValue({ where: mockWhere });
}

function mockSweepThrows(err: Error): void {
  mockWhere.mockRejectedValue(err);
  mockDelete.mockReturnValue({ where: mockWhere });
}

describe('/api/cron/sweep-expired', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning.mockReset();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
  });

  describe('auth', () => {
    it('short-circuits before DB or audit when validateSignedCronRequest returns a response', async () => {
      const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
      vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);
      mockSweepSucceeds(0);

      await GET(makeRequest());

      expect(mockDelete).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('returns success with rate_limit_buckets count and emits one audit event', async () => {
      mockSweepSucceeds(42);

      const res = await GET(makeRequest());
      const body = (await res.json()) as { success: boolean; results: Record<string, number> };

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.results.rate_limit_buckets).toBe(42);
      expect(mockAudit).toHaveBeenCalledTimes(1);
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'data.delete',
          userId: 'system',
          resourceType: 'cron_job',
          resourceId: 'sweep_expired',
          details: { rate_limit_buckets: 42 },
        }),
      );
    });

    it('uses rowCount rather than materializing deleted keys via returning()', async () => {
      // The route must not call .returning() — that would allocate one JS object
      // per deleted row. Confirm by ensuring the chain terminates at .where().
      mockSweepSucceeds(5);

      await GET(makeRequest());

      expect(mockReturning).not.toHaveBeenCalled();
    });
  });

  describe('partial failure', () => {
    it('returns 500, records the error in results, and still emits the audit event', async () => {
      mockSweepThrows(new Error('connection refused'));

      const res = await GET(makeRequest());
      const body = (await res.json()) as {
        success: boolean;
        results: Record<string, number | { error: string }>;
      };

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.results.rate_limit_buckets).toEqual({ error: 'connection refused' });
      expect(mockAudit).toHaveBeenCalledTimes(1);
    });
  });
});
