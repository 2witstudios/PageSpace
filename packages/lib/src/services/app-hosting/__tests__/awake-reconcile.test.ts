import { describe, it, expect, vi } from 'vitest';
import { assert } from '../../sandbox/__tests__/riteway';
import {
  reconcileAwakeSeconds,
  AWAKE_RECONCILE_WINDOW_DAYS,
  MAX_DRIFT_REPORTS,
  type AwakeReconcileDeps,
} from '../awake-reconcile';

const NOW = new Date('2026-08-20T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function makeDeps(over: Partial<AwakeReconcileDeps> = {}) {
  const queryAwakeSeconds = vi.fn(async () => 3600);
  const listBoundaries = vi.fn(async () => [
    { action: 'start' as const, occurredAt: ago(7_200_000) },
    { action: 'stop' as const, occurredAt: ago(3_600_000) },
  ]);
  const deps: AwakeReconcileDeps = {
    isEnabled: () => true,
    resolvePrometheus: () => ({ orgSlug: 'org', token: 'tok' }),
    listApps: async () => [{ id: 'app-1', driveId: 'drive-1', flyAppName: 'pgs-app-1' }],
    listBoundaries,
    queryAwakeSeconds,
    now: () => NOW,
    ...over,
  };
  return { deps, queryAwakeSeconds, listBoundaries };
}

async function reconciled(deps: AwakeReconcileDeps) {
  const run = await reconcileAwakeSeconds(deps);
  if (run.outcome !== 'reconciled') throw new Error(`expected a reconciled run, got ${run.outcome}`);
  return run;
}

describe('reconcileAwakeSeconds — the dark switches', () => {
  it('given the kill switch is off, should report `disabled` and query nothing', async () => {
    const { deps, queryAwakeSeconds } = makeDeps({ isEnabled: () => false });

    expect(await reconcileAwakeSeconds(deps)).toEqual({ outcome: 'disabled' });
    expect(queryAwakeSeconds).not.toHaveBeenCalled();
  });

  it('given no Prometheus credential, should report `unconfigured` — inert, never an error', async () => {
    const listApps = vi.fn(async () => []);
    const { deps } = makeDeps({ resolvePrometheus: () => null, listApps });

    assert({
      given: 'a deployment with no FLY_PROMETHEUS_ORG_SLUG',
      should: 'skip cleanly without listing apps',
      actual: { run: await reconcileAwakeSeconds(deps), listed: listApps.mock.calls.length },
      expected: { run: { outcome: 'unconfigured' }, listed: 0 },
    });
  });
});

describe('reconcileAwakeSeconds — comparison', () => {
  it('compares OUR MIRRORED BOUNDARIES against Prometheus, not our billing watermark', async () => {
    // Comparing the watermark would be comparing our arithmetic against itself.
    const { deps, listBoundaries } = makeDeps();

    const run = await reconciled(deps);

    expect(listBoundaries).toHaveBeenCalledWith(
      'app-1',
      new Date(NOW.getTime() - AWAKE_RECONCILE_WINDOW_DAYS * 24 * 60 * 60 * 1000),
      NOW,
    );
    assert({
      given: 'an hour of awake time in both records',
      should: 'compare it and find no drift',
      actual: { compared: run.compared, drifted: run.drifted },
      expected: { compared: 1, drifted: 0 },
    });
  });

  it('queries Prometheus over the SAME window it reads boundaries for', async () => {
    const { deps, queryAwakeSeconds } = makeDeps();

    await reconciled(deps);

    expect(queryAwakeSeconds).toHaveBeenCalledWith(
      'pgs-app-1',
      AWAKE_RECONCILE_WINDOW_DAYS * 24 * 60 * 60,
    );
  });

  it('given an app with NO series, should count `noSeries` rather than a fault', async () => {
    // An app that has never been woken has no `fly_instance_up` series at all.
    const { deps, listBoundaries } = makeDeps({ queryAwakeSeconds: vi.fn(async () => null) });

    const run = await reconciled(deps);

    assert({
      given: 'an app Prometheus has never seen',
      should: 'count it as noSeries and not compare it',
      actual: { noSeries: run.noSeries, compared: run.compared, failed: run.failed },
      expected: { noSeries: 1, compared: 0, failed: 0 },
    });
    expect(listBoundaries).not.toHaveBeenCalled();
  });

  it('reports drift with its direction when the two records disagree', async () => {
    const { deps } = makeDeps({ queryAwakeSeconds: vi.fn(async () => 100) });

    const run = await reconciled(deps);

    expect(run.drifted).toBe(1);
    expect(run.reports[0]).toMatchObject({
      publishedAppId: 'app-1',
      driveId: 'drive-1',
      flyAppName: 'pgs-app-1',
      localSeconds: 3600,
      prometheusSeconds: 100,
    });
    // We billed far more than Fly saw — the direction that costs a customer.
    expect(run.reports[0].drift.direction).toBe('over_billed');
  });

  it('MOVES NO MONEY — it exposes no settle, charge or adjustment seam at all', async () => {
    // A scraped gauge is not evidence of a charge. The deps surface is the proof:
    // there is nothing here that could write to a ledger.
    const { deps } = makeDeps({ queryAwakeSeconds: vi.fn(async () => 100) });

    await reconciled(deps);

    assert({
      given: 'the reconcile’s full dependency surface',
      should: 'contain only reads and no money movement',
      actual: Object.keys(deps).sort(),
      expected: [
        'isEnabled',
        'listApps',
        'listBoundaries',
        'now',
        'queryAwakeSeconds',
        'resolvePrometheus',
      ],
    });
  });
});

describe('reconcileAwakeSeconds — reporting and isolation', () => {
  it('sorts OVER-BILLED ahead of under-billed, then by magnitude', async () => {
    // An operator reading a truncated list should see the charges somebody may
    // have to be refunded before the revenue we failed to capture.
    const apps = [
      { id: 'under-big', driveId: 'd', flyAppName: 'under-big' },
      { id: 'over-small', driveId: 'd', flyAppName: 'over-small' },
    ];
    const { deps } = makeDeps({
      listApps: async () => apps,
      // `under-big` : we billed 3600, Fly saw 100000 (huge under-bill).
      // `over-small`: we billed 3600, Fly saw 3000 (modest over-bill).
      queryAwakeSeconds: vi.fn(async (flyAppName: string) =>
        flyAppName === 'under-big' ? 100_000 : 3_000,
      ),
    });

    const run = await reconciled(deps);

    assert({
      given: 'a large under-bill and a small over-bill',
      should: 'rank the over-bill first regardless of magnitude',
      actual: run.reports.map((r) => r.drift.direction),
      expected: ['over_billed', 'under_billed'],
    });
  });

  it('caps the report LIST while keeping the drifted COUNT exact', async () => {
    const apps = Array.from({ length: MAX_DRIFT_REPORTS + 10 }, (_, i) => ({
      id: `app-${i}`,
      driveId: 'd',
      flyAppName: `fly-${i}`,
    }));
    const { deps } = makeDeps({ listApps: async () => apps, queryAwakeSeconds: vi.fn(async () => 100) });

    const run = await reconciled(deps);

    assert({
      given: 'more drifting apps than the report cap',
      should: 'truncate the list but not the count',
      actual: { count: run.drifted, listed: run.reports.length },
      expected: { count: MAX_DRIFT_REPORTS + 10, listed: MAX_DRIFT_REPORTS },
    });
  });

  it('ISOLATES one app’s failure — the rest of the run still reports', async () => {
    const { deps } = makeDeps({
      listApps: async () => [
        { id: 'bad', driveId: 'd', flyAppName: 'bad' },
        { id: 'good', driveId: 'd', flyAppName: 'good' },
      ],
      queryAwakeSeconds: vi.fn(async (flyAppName: string) => {
        if (flyAppName === 'bad') throw new Error('prometheus 502');
        return 3600;
      }),
    });

    const run = await reconciled(deps);

    assert({
      given: 'a Prometheus outage on one app mid-run',
      should: 'count it failed and still compare the other',
      actual: { processed: run.processed, failed: run.failed, compared: run.compared },
      expected: { processed: 2, failed: 1, compared: 1 },
    });
  });

  it('given the app list itself fails, should report rather than throw', async () => {
    const { deps } = makeDeps({
      listApps: async () => {
        throw new Error('db down');
      },
    });

    const run = await reconciled(deps);

    expect({ processed: run.processed, compared: run.compared, failed: run.failed }).toEqual({
      processed: 0,
      compared: 0,
      failed: 1,
    });
  });

  it('keeps the window inside Prometheus’ ~15-day retention', async () => {
    // Widening past retention would silently compare against samples that no
    // longer exist, reading as a fleet-wide under-bill rather than missing data.
    expect(AWAKE_RECONCILE_WINDOW_DAYS).toBeLessThan(15);
    expect(AWAKE_RECONCILE_WINDOW_DAYS).toBeGreaterThanOrEqual(7);
  });
});
