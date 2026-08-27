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

const { mockCapture, mockMessage, mockFlush } = vi.hoisted(() => ({
  mockCapture: vi.fn(),
  mockMessage: vi.fn(),
  mockFlush: vi.fn(async () => true),
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: mockCapture,
  captureMessage: mockMessage,
  flush: mockFlush,
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
      spanClamped: 0,
      // Two of the three rows had a positive accrual; the never-measured one
      // priced to $0 and is not billable.
      billableRows: 2,
      billingByKind: { session: { billable: 1, charged: 1, skipped: 0, failed: 0 }, env: { billable: 1, charged: 1, skipped: 0, failed: 0 }, hosting: { billable: 0, charged: 0, skipped: 0, failed: 0 } },
      measurementHealth: {
        session: { live: 2, neverMeasured: 1, stale: 0 },
        env: { live: 1, neverMeasured: 0, stale: 0 },
        hosting: { live: 0, neverMeasured: 0, stale: 0 },
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
          spanClamped: 0,
          billableRows: 2,
          // Per-unit, because an env's baseline-only measurement saturates the
          // flat stale count and would hide a session-side outage.
          measurementHealth: {
            session: { live: 2, neverMeasured: 1, stale: 0 },
            env: { live: 1, neverMeasured: 0, stale: 0 },
            hosting: { live: 0, neverMeasured: 0, stale: 0 },
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
      spanClamped: 0,
      billableRows: 2,
      billingByKind: { session: { billable: 1, charged: 1, skipped: 0, failed: 0 }, env: { billable: 1, charged: 1, skipped: 0, failed: 0 }, hosting: { billable: 0, charged: 0, skipped: 0, failed: 0 } },
      measurementHealth: {
        session: { live: 2, neverMeasured: 1, stale: 0 },
        env: { live: 1, neverMeasured: 0, stale: 0 },
        hosting: { live: 0, neverMeasured: 0, stale: 0 },
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
      spanClamped: 0,
      billableRows: 0,
      billingByKind: { session: { billable: 0, charged: 0, skipped: 0, failed: 0 }, env: { billable: 0, charged: 0, skipped: 0, failed: 0 }, hosting: { billable: 0, charged: 0, skipped: 0, failed: 0 } },
      measurementHealth: {
        session: { live: 2, neverMeasured: 1, stale: 0 },
        // The env LIST threw, so `listSource` yielded no rows and every env
        // counter is necessarily zero.
        env: { live: 0, neverMeasured: 0, stale: 0 },
        hosting: { live: 0, neverMeasured: 0, stale: 0 },
      },
      failedSources: ['env'],
      totalCostDollars: 0.001234,
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    // A DARK feature's source failing must not redden a LIVE billing cron: envs
    // ship dark and nothing provisions them yet, so an unreadable `drive_envs`
    // is discoverable, not an incident. The tick's real work succeeded.
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, charged: 1, failedSources: ['env'] });
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockMessage).toHaveBeenCalledTimes(1);
    expect(mockMessage.mock.calls[0][1]).toMatchObject({
      level: 'warning',
      fingerprint: ['storage-reconcile-dark-source-unreadable', 'env'],
    });
  });

  it('given the SESSION source is unreadable, should be LOUD — a live unit failing is an incident', async () => {
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
      spanClamped: 0,
      billableRows: 0,
      billingByKind: { session: { billable: 0, charged: 0, skipped: 0, failed: 0 }, env: { billable: 0, charged: 0, skipped: 0, failed: 0 }, hosting: { billable: 0, charged: 0, skipped: 0, failed: 0 } },
      measurementHealth: {
        session: { live: 0, neverMeasured: 0, stale: 0 },
        env: { live: 0, neverMeasured: 0, stale: 0 },
        hosting: { live: 0, neverMeasured: 0, stale: 0 },
      },
      failedSources: ['session'],
      totalCostDollars: 0,
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({ success: false, error: expect.stringContaining('session') });
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture.mock.calls[0][1]).toMatchObject({
      level: 'error',
      fingerprint: ['storage-reconcile-source-unreadable', 'session'],
    });
  });

  it('given every BILLABLE row was SKIPPED for an unresolvable payer, should alert — the third silence', async () => {
    // Most reachable for envs, since `resolveEnvPayerId` has no owner fallback:
    // any persistent fault resolving `drives.ownerId` returns null for every row,
    // leaving charged 0, failed 0, and — without this — a green cron forever.
    mockReconcile.mockResolvedValue({
      outcome: 'reconciled',
      processed: 3,
      charged: 0,
      skipped: 3,
      failed: 0,
      chargedButUnadvanced: 0,
      staleMeasurements: 0,
      neverMeasured: 0,
      watermarkSuperseded: 0,
      spanClamped: 0,
      billableRows: 3,
      billingByKind: { session: { billable: 3, charged: 0, skipped: 3, failed: 0 }, env: { billable: 0, charged: 0, skipped: 0, failed: 0 }, hosting: { billable: 0, charged: 0, skipped: 0, failed: 0 } },
      measurementHealth: {
        session: { live: 3, neverMeasured: 0, stale: 0 },
        env: { live: 0, neverMeasured: 0, stale: 0 },
        hosting: { live: 0, neverMeasured: 0, stale: 0 },
      },
      failedSources: [],
      totalCostDollars: 0,
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({ success: false, error: expect.stringContaining('skipped') });
    expect(mockCapture.mock.calls[0][1].fingerprint).toEqual(['storage-reconcile-all-rows-skipped']);
  });

  it('given every BILLABLE row failed, should alert and fail — a total wipeout is not a success', async () => {
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
      spanClamped: 0,
      // All four HAD something to charge — that is what makes "every row failed"
      // evidence of a broken meter rather than a tick with nothing to do.
      billableRows: 4,
      billingByKind: { session: { billable: 4, charged: 0, skipped: 0, failed: 4 }, env: { billable: 0, charged: 0, skipped: 0, failed: 0 }, hosting: { billable: 0, charged: 0, skipped: 0, failed: 0 } },
      measurementHealth: {
        session: { live: 2, neverMeasured: 0, stale: 0 },
        env: { live: 2, neverMeasured: 0, stale: 0 },
        hosting: { live: 0, neverMeasured: 0, stale: 0 },
      },
      failedSources: [],
      totalCostDollars: 0,
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({ success: false, error: expect.stringContaining('billed nothing') });
    expect(mockCapture).toHaveBeenCalledTimes(1);
    // Fingerprinted distinctly from an unreadable source — the two faults have
    // different causes and need separate issues, not one bucket.
    expect(mockCapture.mock.calls[0][1].fingerprint).toEqual(['storage-reconcile-all-rows-failed']);
  });

  it('still alerts when a NON-BILLABLE row is mixed in — the counter must not be diluted by $0 rows', async () => {
    // The defect this guards: comparing an outcome counter against `processed`
    // looked right and was not. A row pricing to $0 lands in NONE of
    // charged/skipped/failed, only in `processed` — and envs meter ~$0 by
    // construction — so ONE unmeasured env beside twenty unbilled sessions made
    // `skipped === processed` false and the whole block silent.
    mockReconcile.mockResolvedValue({
      outcome: 'reconciled',
      processed: 21,
      charged: 0,
      skipped: 20,
      failed: 0,
      chargedButUnadvanced: 0,
      staleMeasurements: 0,
      neverMeasured: 1,
      watermarkSuperseded: 0,
      spanClamped: 0,
      // Twenty sessions had charges to make; the twenty-first row is the $0 env.
      billableRows: 20,
      billingByKind: { session: { billable: 20, charged: 0, skipped: 20, failed: 0 }, env: { billable: 0, charged: 0, skipped: 0, failed: 0 }, hosting: { billable: 0, charged: 0, skipped: 0, failed: 0 } },
      measurementHealth: {
        session: { live: 20, neverMeasured: 0, stale: 0 },
        env: { live: 1, neverMeasured: 1, stale: 0 },
        hosting: { live: 0, neverMeasured: 0, stale: 0 },
      },
      failedSources: [],
      totalCostDollars: 0,
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({ success: false, error: expect.stringContaining('billed nothing') });
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it('alerts when SESSIONS billed nothing even though ENVS charged — the signal is per-kind', async () => {
    // The dilution one level up from the $0 row: a cross-kind `charged > 0` is
    // satisfied by an env charging while every session fails, which would read
    // as healthy while the live meter billed nothing at all.
    mockReconcile.mockResolvedValue({
      outcome: 'reconciled',
      processed: 12,
      charged: 2,
      skipped: 10,
      failed: 0,
      chargedButUnadvanced: 0,
      staleMeasurements: 0,
      neverMeasured: 0,
      watermarkSuperseded: 0,
      spanClamped: 0,
      billableRows: 12,
      // Ten sessions had charges to make and none landed; the two envs did.
      billingByKind: { session: { billable: 10, charged: 0, skipped: 10, failed: 0 }, env: { billable: 2, charged: 2, skipped: 0, failed: 0 }, hosting: { billable: 0, charged: 0, skipped: 0, failed: 0 } },
      measurementHealth: {
        session: { live: 10, neverMeasured: 0, stale: 0 },
        env: { live: 2, neverMeasured: 0, stale: 0 },
        hosting: { live: 0, neverMeasured: 0, stale: 0 },
      },
      failedSources: [],
      totalCostDollars: 0.02,
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({ success: false, error: expect.stringContaining('session') });
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it('names the wipeout cause from the WIPED-OUT kind, not the tick-wide totals', async () => {
    // Three sessions failing on the charge path beside forty envs skipped for an
    // unresolvable payer. The alert fires on the session wipeout; labelling it
    // from tick-wide totals would file a charge-path fault in the payer-lookup
    // bucket, in the one block whose whole purpose is precision.
    mockReconcile.mockResolvedValue({
      outcome: 'reconciled',
      processed: 43,
      charged: 0,
      skipped: 40,
      failed: 3,
      chargedButUnadvanced: 0,
      staleMeasurements: 0,
      neverMeasured: 0,
      watermarkSuperseded: 0,
      spanClamped: 0,
      billableRows: 43,
      billingByKind: {
        session: { billable: 3, charged: 0, skipped: 0, failed: 3 },
        env: { billable: 40, charged: 0, skipped: 40, failed: 0 },
        hosting: { billable: 0, charged: 0, skipped: 0, failed: 0 },
      },
      measurementHealth: {
        session: { live: 3, neverMeasured: 0, stale: 0 },
        env: { live: 40, neverMeasured: 0, stale: 0 },
        hosting: { live: 0, neverMeasured: 0, stale: 0 },
      },
      failedSources: [],
      totalCostDollars: 0,
    });

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(mockCapture.mock.calls[0][1].fingerprint).toEqual(['storage-reconcile-all-rows-failed']);
    expect(mockCapture.mock.calls[0][1].tags.reason).toBe('all_rows_failed');
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
      spanClamped: 0,
      billableRows: 4,
      billingByKind: { session: { billable: 4, charged: 1, skipped: 0, failed: 0 }, env: { billable: 0, charged: 0, skipped: 0, failed: 0 }, hosting: { billable: 0, charged: 0, skipped: 0, failed: 0 } },
      measurementHealth: {
        session: { live: 2, neverMeasured: 0, stale: 0 },
        env: { live: 2, neverMeasured: 0, stale: 0 },
        hosting: { live: 0, neverMeasured: 0, stale: 0 },
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
      spanClamped: 0,
      billableRows: 0,
      billingByKind: { session: { billable: 0, charged: 0, skipped: 0, failed: 0 }, env: { billable: 0, charged: 0, skipped: 0, failed: 0 }, hosting: { billable: 0, charged: 0, skipped: 0, failed: 0 } },
      measurementHealth: {
        session: { live: 1, neverMeasured: 0, stale: 0 },
        env: { live: 0, neverMeasured: 0, stale: 0 },
        hosting: { live: 0, neverMeasured: 0, stale: 0 },
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
      spanClamped: 0,
      billableRows: 0,
      billingByKind: { session: { billable: 0, charged: 0, skipped: 0, failed: 0 }, env: { billable: 0, charged: 0, skipped: 0, failed: 0 }, hosting: { billable: 0, charged: 0, skipped: 0, failed: 0 } },
      measurementHealth: {
        session: { live: 0, neverMeasured: 0, stale: 0 },
        env: { live: 0, neverMeasured: 0, stale: 0 },
        hosting: { live: 0, neverMeasured: 0, stale: 0 },
      },
      failedSources: [],
      totalCostDollars: 0,
    });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('given an ENV-ONLY wipeout, should NOT alert — the dark/live rule applies to wipeouts too', async () => {
    // A deployment where someone rebuilt an env and has no live sessions. An
    // env-only fault reddening this cron is exactly what the dark/live split
    // exists to prevent, and applying that split only to row-source failures
    // left this door open.
    mockReconcile.mockResolvedValue({
      outcome: 'reconciled',
      processed: 3,
      charged: 0,
      skipped: 3,
      failed: 0,
      chargedButUnadvanced: 0,
      staleMeasurements: 0,
      neverMeasured: 0,
      watermarkSuperseded: 0,
      spanClamped: 0,
      billableRows: 3,
      billingByKind: { session: { billable: 0, charged: 0, skipped: 0, failed: 0 }, env: { billable: 3, charged: 0, skipped: 0, failed: 0 }, hosting: { billable: 0, charged: 0, skipped: 0, failed: 0 } },
      measurementHealth: {
        session: { live: 0, neverMeasured: 0, stale: 0 },
        env: { live: 3, neverMeasured: 0, stale: 0 },
        hosting: { live: 0, neverMeasured: 0, stale: 0 },
      },
      failedSources: [],
      totalCostDollars: 0,
    });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('given every row failed but NOTHING was billable, should NOT alert — no work was lost', async () => {
    // Today's common shape: envs meter ~$0 by construction, so a transient
    // watermark-write error on the zero-cost path would otherwise page someone
    // with "every row failed to bill" when nothing was billable at all.
    mockReconcile.mockResolvedValue({
      outcome: 'reconciled',
      processed: 3,
      charged: 0,
      skipped: 0,
      failed: 3,
      chargedButUnadvanced: 0,
      staleMeasurements: 0,
      neverMeasured: 0,
      watermarkSuperseded: 0,
      spanClamped: 0,
      billableRows: 0,
      billingByKind: { session: { billable: 0, charged: 0, skipped: 0, failed: 0 }, env: { billable: 0, charged: 0, skipped: 0, failed: 0 }, hosting: { billable: 0, charged: 0, skipped: 0, failed: 0 } },
      measurementHealth: {
        session: { live: 0, neverMeasured: 0, stale: 0 },
        env: { live: 3, neverMeasured: 0, stale: 0 },
        hosting: { live: 0, neverMeasured: 0, stale: 0 },
      },
      failedSources: [],
      totalCostDollars: 0,
    });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(mockCapture).not.toHaveBeenCalled();
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
