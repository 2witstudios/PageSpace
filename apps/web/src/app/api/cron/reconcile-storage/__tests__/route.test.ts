/**
 * Contract tests for /api/cron/reconcile-storage (#2155).
 * Verifies HMAC gating, audit logging, and that failed per-user corrections
 * surface as a non-success response rather than being silently swallowed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockReconcile, mockAudit, mockLogError } = vi.hoisted(() => ({
  mockReconcile: vi.fn(),
  mockAudit: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/services/storage-limits', () => ({
  reconcileAllStorageUsageSerialized: mockReconcile,
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: mockAudit,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { system: { error: mockLogError } },
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
  return new Request('http://localhost:3000/api/cron/reconcile-storage');
}

describe('/api/cron/reconcile-storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockReconcile.mockResolvedValue({ outcome: 'reconciled', corrected: [], failed: [] });
  });

  it('returns the auth error and never reconciles when auth fails', async () => {
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('reconciles and emits a data.write audit event with the correction counts', async () => {
    mockReconcile.mockResolvedValue({
      outcome: 'reconciled',
      corrected: [{ userId: 'user-1', previousUsage: 2000, actualUsage: 1500, driftBytes: 500 }],
      failed: [],
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'data.write',
        resourceType: 'cron_job',
        resourceId: 'reconcile_storage',
        details: expect.objectContaining({ corrected: 1, failed: 0 }),
      }),
    );
    expect(body).toMatchObject({ success: true, corrected: 1, failed: 0 });
  });

  it('given per-user failures, should report success=false and log an error', async () => {
    mockReconcile.mockResolvedValue({ outcome: 'reconciled', corrected: [], failed: ['user-2'] });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body).toMatchObject({ success: false, corrected: 0, failed: 1 });
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('Storage reconcile'),
      undefined,
      expect.objectContaining({ failed: ['user-2'] }),
    );
    // Still audits the run even with failures — the failure itself is data.
    expect(mockAudit).toHaveBeenCalled();
  });

  it('returns a 500 with the error message when reconcile throws', async () => {
    mockReconcile.mockRejectedValue(new Error('db exploded'));

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({ success: false, error: 'db exploded' });
  });

  it('POST delegates to GET', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  it('given the advisory lock is held by another run, should no-op WITHOUT auditing and report lock_busy', async () => {
    mockReconcile.mockResolvedValue({ outcome: 'lock_busy' });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, outcome: 'lock_busy' });
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
