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

const { mockCapture, mockFlush } = vi.hoisted(() => ({
  mockCapture: vi.fn(),
  mockFlush: vi.fn(async () => true),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: mockCapture, flush: mockFlush }));

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
    mockFlush.mockResolvedValue(true);
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    // A run the reconcile could ACTUALLY produce, because a fixture pinned
    // against an impossible state is a weak guard. Two live sessions and one
    // live env, both sources read cleanly: one session measured and charged,
    // one never measured (so it bills the 0 floor and is neither `charged` nor
    // `skipped`), the env measured and charged. `live` sums to `processed`, and
    // the per-unit counters sum to the flat totals.
    mockReconcile.mockResolvedValue({
      outcome: 'reconciled',
      processed: 3,
      charged: 2,
      skipped: 0,
      failed: 0,
      chargedButUnadvanced: 0,
      staleMeasurements: 0,
      neverMeasured: 1,
      watermarkSuperseded: 0,
      measurementHealth: {
        session: { live: 2, neverMeasured: 1, stale: 0 },
        env: { live: 1, neverMeasured: 0, stale: 0 },
      },
      failedSources: [],
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
          processed: 3,
          charged: 2,
          skipped: 0,
          failed: 0,
          chargedButUnadvanced: 0,
          staleMeasurements: 0,
          // The two signals that make an under-billing meter visible: storage
          // held with no reading at all, and a persistence unit that went
          // entirely unread this tick.
          neverMeasured: 1,
          watermarkSuperseded: 0,
          // Per-unit, because an env's baseline-only measurement saturates the
          // flat stale count and would hide a session-side outage.
          measurementHealth: {
            session: { live: 2, neverMeasured: 1, stale: 0 },
            env: { live: 1, neverMeasured: 0, stale: 0 },
          },
          failedSources: [],
        }),
      }),
    );
    expect(body).toMatchObject({
      success: true,
      processed: 3,
      charged: 2,
      skipped: 0,
      failed: 0,
      chargedButUnadvanced: 0,
      staleMeasurements: 0,
      neverMeasured: 1,
      watermarkSuperseded: 0,
      measurementHealth: {
        session: { live: 2, neverMeasured: 1, stale: 0 },
        env: { live: 1, neverMeasured: 0, stale: 0 },
      },
      failedSources: [],
    });
  });

  it('given a row source that could NOT be read, should FAIL the tick while still reporting what it billed', async () => {
    // Isolation inside the reconcile is right — an unreadable `drive_envs` must
    // never stop SESSION billing — but a green 200 here would trade one silence
    // for another: a deployment where the env table is unmigrated or unreadable
    // fails EVERY tick, so "it accrues and is caught up next tick" never comes
    // true, and the only trace is a logger this repo does not route to Sentry.
    mockReconcile.mockResolvedValue({
      outcome: 'reconciled',
      processed: 2,
      charged: 1,
      skipped: 0,
      failed: 0,
      chargedButUnadvanced: 0,
      staleMeasurements: 0,
      neverMeasured: 1,
      watermarkSuperseded: 0,
      measurementHealth: {
        session: { live: 2, neverMeasured: 1, stale: 0 },
        // The env LIST threw, so `listSource` yielded no rows and every env
        // counter is necessarily zero.
        env: { live: 0, neverMeasured: 0, stale: 0 },
      },
      failedSources: ['env'],
      totalCostDollars: 0.001234,
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({
      success: false,
      error: expect.stringContaining('env'),
      // The work that DID succeed is still reported in full — failing the tick
      // must not hide the money that moved.
      charged: 1,
      totalCostDollars: 0.001234,
      failedSources: ['env'],
      alertDelivered: true,
    });
    // Still audited: the charges happened and the audit trail must show them.
    expect(mockAudit).toHaveBeenCalledTimes(1);
    // And ALERTED. This is the part that reaches a human: the docker cron runs
    // `curl -sS` without `-f`, so it exits 0 on a 500 and the status code alone
    // would be decorative.
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture.mock.calls[0][1]).toMatchObject({
      level: 'error',
      // Fingerprinted on the SOURCES, not the message — a message carrying
      // changing counts would open a fresh issue every hour.
      fingerprint: ['storage-reconcile-source-unreadable', 'env'],
    });
  });

  it('given EVERY row failed to bill, should alert and fail — a total wipeout is not a success', async () => {
    // The same silence one level down from an unreadable source: a persistent
    // fault reading `drives` makes the payer lookup throw for every subject, so
    // nothing is charged and, without this, the cron reports success forever.
    mockReconcile.mockResolvedValue({
      outcome: 'reconciled',
      processed: 4,
      charged: 0,
      skipped: 0,
      failed: 4,
      chargedButUnadvanced: 0,
      staleMeasurements: 0,
      neverMeasured: 0,
      watermarkSuperseded: 0,
      measurementHealth: {
        session: { live: 2, neverMeasured: 0, stale: 0 },
        env: { live: 2, neverMeasured: 0, stale: 0 },
      },
      failedSources: [],
      totalCostDollars: 0,
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({ success: false, error: expect.stringContaining('every row failed') });
    expect(mockCapture).toHaveBeenCalledTimes(1);
    // Fingerprinted distinctly from an unreadable source — the two faults have
    // different causes and need separate issues, not one bucket.
    expect(mockCapture.mock.calls[0][1].fingerprint).toEqual(['storage-reconcile-all-rows-failed']);
  });

  it('given SOME rows failed but others billed, should NOT alert — a partial failure is already counted', async () => {
    // The condition is deliberately total-wipeout, not a threshold: a tuned
    // percentage invites debate and false alarms, while "nothing at all got
    // billed though there was work to do" is unambiguous.
    mockReconcile.mockResolvedValue({
      outcome: 'reconciled',
      processed: 4,
      charged: 1,
      skipped: 0,
      failed: 3,
      chargedButUnadvanced: 0,
      staleMeasurements: 0,
      neverMeasured: 0,
      watermarkSuperseded: 0,
      measurementHealth: {
        session: { live: 2, neverMeasured: 0, stale: 0 },
        env: { live: 2, neverMeasured: 0, stale: 0 },
      },
      failedSources: [],
      totalCostDollars: 0.5,
    });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('given a SINGLE row that failed, should NOT alert — one row cannot distinguish a fault from a transient', async () => {
    // The meter already isolates and retries a per-row failure. With one row
    // there is nothing to corroborate a shared cause, so alerting would page
    // someone for ordinary noise — and on a deployment with one live billable
    // row that would be most ticks.
    mockReconcile.mockResolvedValue({
      outcome: 'reconciled',
      processed: 1,
      charged: 0,
      skipped: 0,
      failed: 1,
      chargedButUnadvanced: 0,
      staleMeasurements: 0,
      neverMeasured: 0,
      watermarkSuperseded: 0,
      measurementHealth: {
        session: { live: 1, neverMeasured: 0, stale: 0 },
        env: { live: 0, neverMeasured: 0, stale: 0 },
      },
      failedSources: [],
      totalCostDollars: 0,
    });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('given a tick with NO rows at all, should NOT alert — an idle meter is not a broken one', async () => {
    mockReconcile.mockResolvedValue({
      outcome: 'reconciled',
      processed: 0,
      charged: 0,
      skipped: 0,
      failed: 0,
      chargedButUnadvanced: 0,
      staleMeasurements: 0,
      neverMeasured: 0,
      watermarkSuperseded: 0,
      measurementHealth: {
        session: { live: 0, neverMeasured: 0, stale: 0 },
        env: { live: 0, neverMeasured: 0, stale: 0 },
      },
      failedSources: [],
      totalCostDollars: 0,
    });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('given the Sentry queue does not drain, should say so rather than claim the alert landed', async () => {
    // `flush` resolves false when no client is initialised — and then
    // `captureException` was a no-op too, so the alert vanished. Reporting
    // success there would rebuild the exact silence this branch exists to close.
    mockFlush.mockResolvedValue(false);
    mockReconcile.mockResolvedValue({
      outcome: 'reconciled',
      processed: 0,
      charged: 0,
      skipped: 0,
      failed: 0,
      chargedButUnadvanced: 0,
      staleMeasurements: 0,
      neverMeasured: 0,
      watermarkSuperseded: 0,
      measurementHealth: {
        session: { live: 0, neverMeasured: 0, stale: 0 },
        env: { live: 0, neverMeasured: 0, stale: 0 },
      },
      failedSources: ['env'],
      totalCostDollars: 0,
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({ success: false, alertDelivered: false });
  });

  it('given a healthy tick, should raise NO alert — an hourly false alarm is worse than none', async () => {
    await GET(makeRequest());

    expect(mockCapture).not.toHaveBeenCalled();
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
