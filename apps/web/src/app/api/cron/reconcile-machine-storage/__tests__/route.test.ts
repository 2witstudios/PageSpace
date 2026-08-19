/**
 * Contract tests for /api/cron/reconcile-machine-storage
 * Verifies HMAC gating, audit logging, and that the reconcile result surfaces
 * in the response for the Terminal Machine idle-storage cron.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockReconcile, mockAudit } = vi.hoisted(() => ({
  mockReconcile: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/services/sandbox/sandbox-storage-billing', () => ({
  defaultReconcileSandboxStorageDeps: {},
  reconcileSandboxStorageSerialized: mockReconcile,
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
  return new Request('http://localhost:3000/api/cron/reconcile-machine-storage');
}

describe('/api/cron/reconcile-machine-storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    // A run the reconcile could ACTUALLY produce, because a fixture pinned
    // against an impossible state is a weak guard. Two live sessions and a
    // failed env listing: one session measured and charged, one never measured
    // (so it bills the 0 floor and is not `charged` or `skipped`), and — since
    // `listSource` yields no rows for a source that threw — every env counter is
    // necessarily zero. `live` therefore sums to `processed`, and the per-unit
    // `neverMeasured`/`stale` sum to the flat totals.
    mockReconcile.mockResolvedValue({
      outcome: 'reconciled',
      processed: 2,
      charged: 1,
      skipped: 0,
      failed: 0,
      chargedButUnadvanced: 0,
      staleMeasurements: 0,
      neverMeasured: 1,
      measurementHealth: {
        session: { live: 2, neverMeasured: 1, stale: 0 },
        env: { live: 0, neverMeasured: 0, stale: 0 },
      },
      failedSources: ['env'],
      totalCostDollars: 0.001234,
    });
  });

  it('returns the auth error and never reconciles when auth fails', async () => {
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('reconciles and emits a data.write audit event with the result counts', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'data.write',
        resourceType: 'cron_job',
        resourceId: 'reconcile_machine_storage',
        details: expect.objectContaining({
          processed: 2,
          charged: 1,
          skipped: 0,
          failed: 0,
          chargedButUnadvanced: 0,
          staleMeasurements: 0,
          // The two signals that make an under-billing meter visible: storage
          // held with no reading at all, and a persistence unit that went
          // entirely unread this tick.
          neverMeasured: 1,
          // Per-unit, because an env's baseline-only measurement saturates the
          // flat stale count and would hide a session-side outage.
          measurementHealth: {
            session: { live: 2, neverMeasured: 1, stale: 0 },
            env: { live: 0, neverMeasured: 0, stale: 0 },
          },
          failedSources: ['env'],
        }),
      }),
    );
    expect(body).toMatchObject({
      success: true,
      processed: 2,
      charged: 1,
      skipped: 0,
      failed: 0,
      chargedButUnadvanced: 0,
      staleMeasurements: 0,
      neverMeasured: 1,
      measurementHealth: {
        session: { live: 2, neverMeasured: 1, stale: 0 },
        env: { live: 0, neverMeasured: 0, stale: 0 },
      },
      failedSources: ['env'],
    });
  });

  it('given the advisory lock is held by another run, should no-op WITHOUT auditing and report lock_busy', async () => {
    mockReconcile.mockResolvedValue({ outcome: 'lock_busy' });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, outcome: 'lock_busy' });
    expect(mockAudit).not.toHaveBeenCalled();
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
});
