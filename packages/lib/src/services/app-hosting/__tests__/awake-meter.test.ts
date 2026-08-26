import { describe, it, expect, vi } from 'vitest';
import { assert } from '../../sandbox/__tests__/riteway';
import { meterAwakePublishedApps, type AwakeMeterDeps } from '../awake-meter';
import type { AppBillingDeps } from '../app-billing';
import { MAX_AWAKE_SETTLE_SPAN_MS } from '../app-metering-core';
import type { PublishedApp } from '@pagespace/db/schema/published-apps';

const NOW = new Date('2026-08-20T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function runningApp(over: Partial<PublishedApp> = {}): PublishedApp {
  return {
    id: 'app-1',
    driveId: 'drive-1',
    flyAppName: 'pgs-app-1',
    machineId: 'machine-1',
    status: 'running',
    tier: 'metered',
    imageDigest: 'sha256:abc',
    lastWakeAt: ago(3_600_000),
    lastStopAt: null,
    awakeBilledThrough: ago(600_000),
    awakeHoldId: 'hold-1',
    awakeSecondsDay: null,
    awakeSecondsToday: 0,
    lastHitAt: null,
    ...over,
  } as unknown as PublishedApp;
}

function makeDeps(over: Partial<AwakeMeterDeps> = {}) {
  const trackUsage = vi.fn<AppBillingDeps['trackUsage']>(async () => ({
    persisted: true,
    creditsSettled: true,
  }));
  // Typed to the seam rather than inferred from this one happy-path literal, so a
  // test can hand it a refusal (which carries `reason` and no `holdId`).
  const gate = vi.fn<AppBillingDeps['gate']>(async () => ({ allowed: true, holdId: 'hold-next' }));
  const releaseHold = vi.fn(async () => {});
  const writeSettle = vi.fn(async () => 'advanced' as const);
  const stampWindowStart = vi.fn(async () => 'stamped' as const);
  const closeAtBoundary = vi.fn(async () => ({ billedSeconds: 600, failed: false }));
  const park = vi.fn(async (_id: string, _reason: 'insolvent' | 'daily_cap') => {});
  const findStopBoundary = vi.fn(async () => null);

  const deps: AwakeMeterDeps = {
    isEnabled: () => true,
    billing: { resolvePayerId: async () => 'payer-1', gate, trackUsage, releaseHold },
    listRunningApps: async () => [runningApp()],
    findStopBoundary,
    writeSettle,
    stampWindowStart,
    closeAtBoundary,
    park,
    dailyAwakeCapSeconds: () => 0,
    now: () => NOW,
    ...over,
  };
  return { deps, trackUsage, gate, releaseHold, writeSettle, stampWindowStart, closeAtBoundary, park, findStopBoundary };
}

/** Narrow the run to its metered shape — `disabled` carries no counters. */
async function meter(deps: AwakeMeterDeps) {
  const run = await meterAwakePublishedApps(deps);
  if (run.outcome !== 'metered') throw new Error(`expected a metered run, got ${run.outcome}`);
  return run;
}

describe('meterAwakePublishedApps — the kill switch', () => {
  it('given APP_HOSTING_ENABLED is off, should report `disabled` and read NOTHING', async () => {
    // A dark feature must never redden a live cron, and must not query for rows
    // it has no business billing.
    const listRunningApps = vi.fn(async () => []);
    const { deps } = makeDeps({ isEnabled: () => false, listRunningApps });

    assert({
      given: 'the hosting kill switch off',
      should: 'report disabled without listing a single app',
      actual: {
        outcome: (await meterAwakePublishedApps(deps)).outcome,
        listed: listRunningApps.mock.calls.length,
      },
      expected: { outcome: 'disabled', listed: 0 },
    });
  });
});

describe('meterAwakePublishedApps — the ordinary settle', () => {
  it('bills the accrued seconds against the window’s hold and advances the watermark', async () => {
    const { deps, trackUsage, writeSettle } = makeDeps();

    const run = await meter(deps);

    expect(trackUsage).toHaveBeenCalledWith({
      payerId: 'payer-1',
      holdId: 'hold-1',
      activeSeconds: 600,
      driveId: 'drive-1',
      publishedAppId: 'app-1',
    });
    assert({
      given: 'an app awake ten minutes past its watermark',
      should: 'settle 600 seconds and advance to now',
      actual: { settled: run.settled, seconds: run.totalAwakeSeconds },
      expected: { settled: 1, seconds: 600 },
    });
    expect(writeSettle).toHaveBeenCalledWith({
      publishedAppId: 'app-1',
      billedThrough: NOW,
      billedSeconds: 600,
      holdId: 'hold-next',
    });
  });

  // ── The persistence CONTRACT (issue: trackUsage must report its outcome) ────
  // `billing.trackUsage` reaches `AIMonitoring.trackUsage`, which never throws.
  // Before it reported an outcome, a settle whose `ai_usage_logs` write failed
  // RESOLVED — so this meter counted it `settled`, advanced the watermark, and
  // closed the window over spend nothing would ever bill. Flip `persisted` and the
  // watermark must HOLD; restore it and it must advance.

  it('given a settle that resolves WITHOUT persisting, HOLDS the watermark so the next tick re-bills the span', async () => {
    const { deps, writeSettle, gate } = makeDeps();
    deps.billing.trackUsage = async () => ({ persisted: false, creditsSettled: false });

    const run = await meter(deps);

    assert({
      given: 'an awake settle that resolved but wrote no usage row',
      should: 'count it failed, bill no seconds, and move no watermark',
      actual: {
        settled: run.settled,
        failed: run.failed,
        seconds: run.totalAwakeSeconds,
        advances: writeSettle.mock.calls.length,
      },
      expected: { settled: 0, failed: 1, seconds: 0, advances: 0 },
    });
    // Not `settledButUnadvanced`: that name means money moved and only the
    // watermark write failed — the opposite situation, and the opposite remedy.
    expect(run.settledButUnadvanced).toBe(0);
    // The re-gate is skipped with the advance: this tick made no window to reserve.
    expect(gate).not.toHaveBeenCalled();
  });

  it('given a PERSISTED settle whose ledger settle was deferred, still ADVANCES the watermark (the backfill cron owns that charge)', async () => {
    // Holding the window open here would re-bill a span the credit backfill cron is
    // already collecting from the usage row — a double-charge caused by trying to
    // prevent a lost one.
    const { deps, writeSettle } = makeDeps();
    deps.billing.trackUsage = async () => ({ persisted: true, creditsSettled: false });

    const run = await meter(deps);

    assert({
      given: 'a persisted settle whose ledger claim was deferred to the backfill cron',
      should: 'settle and close the window exactly as a fully settled charge would',
      actual: { settled: run.settled, failed: run.failed, advances: writeSettle.mock.calls.length },
      expected: { settled: 1, failed: 0, advances: 1 },
    });
  });

  it('RE-GATES after every settle, because the settle consumed the wake’s hold', async () => {
    // Without the re-hold, a payer who runs out mid-window keeps a machine awake
    // indefinitely and the balance is only ever consulted at the next cold wake.
    const { deps, gate } = makeDeps();

    await meter(deps);

    expect(gate).toHaveBeenCalledWith({ payerId: 'payer-1' });
  });

  it('given the re-gate REFUSES, should ADVANCE THE WATERMARK BEFORE parking — the span is already charged', async () => {
    // The regression this guards: parking on the stale watermark makes
    // `stopPublishedApp` re-read it and settle the same span a SECOND time, so
    // every insolvency park double-charged nearly a whole heartbeat interval.
    const order: string[] = [];
    const { deps, gate, park, writeSettle } = makeDeps();
    gate.mockResolvedValue({ allowed: false, reason: 'insufficient_credits' });
    writeSettle.mockImplementation(async () => {
      order.push('advance');
      return 'advanced' as const;
    });
    park.mockImplementation(async () => {
      order.push('park');
    });

    const run = await meter(deps);

    assert({
      given: 'a payer who ran out of credits mid-window',
      should: 'record the charge it already made, then park',
      actual: { parked: run.parked, order },
      expected: { parked: 1, order: ['advance', 'park'] },
    });
    // Advanced to the instant just billed, carrying NO hold: the settle consumed
    // the wake's, and the gate refused to give another.
    expect(writeSettle).toHaveBeenCalledWith({
      publishedAppId: 'app-1',
      billedThrough: NOW,
      billedSeconds: 600,
      holdId: null,
    });
  });

  it('given the re-gate THROWS, should keep the app up and still close the window with no hold', async () => {
    // A transient billing outage must not kill a live app.
    const { deps, gate, writeSettle, park } = makeDeps();
    gate.mockRejectedValue(new Error('gate down'));

    const run = await meter(deps);

    expect(park).not.toHaveBeenCalled();
    expect(writeSettle).toHaveBeenCalledWith({ publishedAppId: 'app-1', billedThrough: NOW, billedSeconds: 600, holdId: null });
    expect(run.settled).toBe(1);
  });

  it('given a span longer than a day, should clamp it and count the clamp', async () => {
    const { deps, trackUsage } = makeDeps({
      listRunningApps: async () => [runningApp({ awakeBilledThrough: ago(MAX_AWAKE_SETTLE_SPAN_MS * 2) })],
    });

    const run = await meter(deps);

    expect(run.clamped).toBe(1);
    expect(trackUsage.mock.calls[0]?.[0].activeSeconds).toBe(MAX_AWAKE_SETTLE_SPAN_MS / 1000);
  });

  it('given no elapsed time, should SKIP without billing', async () => {
    const { deps, trackUsage } = makeDeps({
      listRunningApps: async () => [runningApp({ awakeBilledThrough: NOW })],
    });

    const run = await meter(deps);

    assert({
      given: 'a back-to-back rerun',
      should: 'skip and charge nothing',
      actual: { skipped: run.skipped, settled: run.settled, charges: trackUsage.mock.calls.length },
      expected: { skipped: 1, settled: 0, charges: 0 },
    });
  });
});

describe('meterAwakePublishedApps — the repair path', () => {
  it('given the mirror holds a stop after the watermark, should close at the REAL boundary and never bill to now', async () => {
    const boundary = ago(300_000);
    const { deps, closeAtBoundary, trackUsage } = makeDeps({
      findStopBoundary: vi.fn(async () => boundary),
    });

    const run = await meter(deps);

    assert({
      given: 'a stop whose status write was lost',
      should: 'repair the window at the mirrored boundary',
      actual: { repaired: run.repaired, seconds: run.totalAwakeSeconds },
      expected: { repaired: 1, seconds: 600 },
    });
    expect(closeAtBoundary).toHaveBeenCalledWith(expect.objectContaining({ id: 'app-1' }), boundary);
    // The ordinary settle path must NOT also run for this row.
    expect(trackUsage).not.toHaveBeenCalled();
  });

  it('given the repair’s settle failed, should count the failure and not the seconds', async () => {
    const { deps } = makeDeps({
      findStopBoundary: vi.fn(async () => ago(300_000)),
      closeAtBoundary: vi.fn(async () => ({ billedSeconds: 0, failed: true })),
    });

    const run = await meter(deps);

    expect({ repaired: run.repaired, failed: run.failed, seconds: run.totalAwakeSeconds }).toEqual({
      repaired: 1,
      failed: 1,
      seconds: 0,
    });
  });

  it('given a running row with no machine, should not ask the mirror for boundaries with an empty id', async () => {
    const findStopBoundary = vi.fn(async () => null);
    const { deps } = makeDeps({
      listRunningApps: async () => [runningApp({ machineId: null })],
      findStopBoundary,
    });

    await meter(deps);

    expect(findStopBoundary).not.toHaveBeenCalled();
  });
});

describe('meterAwakePublishedApps — a running row with no window', () => {
  it('STAMPS the clock at now and bills nothing for the unknown span', async () => {
    // An unknown window start must cost the payer nothing rather than an
    // invented amount.
    const { deps, trackUsage, stampWindowStart } = makeDeps({
      listRunningApps: async () => [runningApp({ awakeBilledThrough: null })],
    });

    const run = await meter(deps);

    assert({
      given: 'a `running` row carrying no watermark',
      should: 'start its clock at now and charge nothing',
      actual: { stamped: run.stamped, settled: run.settled, charges: trackUsage.mock.calls.length },
      expected: { stamped: 1, settled: 0, charges: 0 },
    });
    expect(stampWindowStart).toHaveBeenCalledWith({ publishedAppId: 'app-1', at: NOW, holdId: 'hold-next' });
  });

  it('gates before stamping, and parks an insolvent payer instead of opening a window', async () => {
    const { deps, gate, stampWindowStart, park } = makeDeps({
      listRunningApps: async () => [runningApp({ awakeBilledThrough: null })],
    });
    gate.mockResolvedValue({ allowed: false, reason: 'insufficient_credits' });

    const run = await meter(deps);

    expect(run.parked).toBe(1);
    expect(park).toHaveBeenCalledWith('app-1', 'insolvent');
    expect(stampWindowStart).not.toHaveBeenCalled();
  });

  it('given an unresolvable drive, should count it and open no window', async () => {
    const { deps, stampWindowStart } = makeDeps({
      listRunningApps: async () => [runningApp({ awakeBilledThrough: null })],
    });
    deps.billing.resolvePayerId = async () => null;

    const run = await meter(deps);

    expect(run.unresolvedPayer).toBe(1);
    expect(stampWindowStart).not.toHaveBeenCalled();
  });
});

describe('meterAwakePublishedApps — attribution and isolation', () => {
  it('given an unresolvable drive on a settle, should leave the watermark so the span is billed in full later', async () => {
    // Never substitute a payer: a misdirected charge cannot be taken back, a
    // skipped tick corrects itself.
    const { deps, trackUsage, writeSettle } = makeDeps();
    deps.billing.resolvePayerId = async () => null;

    const run = await meter(deps);

    assert({
      given: 'a drive that cannot be resolved to an owner',
      should: 'charge nobody and move no watermark',
      actual: {
        unresolved: run.unresolvedPayer,
        charges: trackUsage.mock.calls.length,
        advances: writeSettle.mock.calls.length,
      },
      expected: { unresolved: 1, charges: 0, advances: 0 },
    });
  });

  it('ISOLATES one bad row — the rest of the fleet is still billed', async () => {
    const trackUsage = vi.fn(async (input: { publishedAppId: string }) => {
      if (input.publishedAppId === 'app-bad') throw new Error('boom');
      return { persisted: true, creditsSettled: true };
    });
    const { deps } = makeDeps({
      listRunningApps: async () => [
        runningApp({ id: 'app-bad' }),
        runningApp({ id: 'app-good' }),
      ],
    });
    deps.billing.trackUsage = trackUsage;

    const run = await meter(deps);

    assert({
      given: 'one app whose settle throws',
      should: 'count it failed and still bill the other',
      actual: { processed: run.processed, failed: run.failed, settled: run.settled },
      expected: { processed: 2, failed: 1, settled: 1 },
    });
  });

  it('given the ROW SOURCE itself fails, should report `sourceFailed` rather than throwing', async () => {
    const { deps } = makeDeps({
      listRunningApps: async () => {
        throw new Error('db down');
      },
    });

    const run = await meter(deps);

    expect({ sourceFailed: run.sourceFailed, processed: run.processed }).toEqual({
      sourceFailed: true,
      processed: 0,
    });
  });

  it('given the watermark write fails AFTER a successful settle, should count `settledButUnadvanced`', async () => {
    // Money moved and the window did not close, so this span WILL be billed
    // again next tick — the opposite of `failed`, and counted under its own name.
    const { deps } = makeDeps({
      writeSettle: vi.fn(async () => {
        throw new Error('write lost');
      }),
    });

    const run = await meter(deps);

    assert({
      given: 'a charge that committed and a watermark advance that did not',
      should: 'flag the double-bill risk distinctly from an ordinary failure',
      actual: { settledButUnadvanced: run.settledButUnadvanced, failed: run.failed, settled: run.settled },
      expected: { settledButUnadvanced: 1, failed: 0, settled: 1 },
    });
  });

  it('given a concurrent wake already carried the watermark past this tick, should count it superseded AND return the re-hold', async () => {
    // The wake owns the window and holds its own reservation for it. Ours covers
    // nothing, so leaving it in place would suppress the payer's spendable
    // balance for the whole hold TTL with nothing ever settling it.
    const { deps, releaseHold } = makeDeps({ writeSettle: vi.fn(async () => 'superseded' as const) });

    const run = await meter(deps);

    assert({
      given: 'a wake that carried the row past this tick mid-settle',
      should: 'count the refusal and release the reservation nothing will settle',
      actual: { superseded: run.watermarkSuperseded, released: releaseHold.mock.calls },
      expected: { superseded: 1, released: [['hold-next']] },
    });
  });

  it('given a stop closed the window mid-tick, should also return the re-hold rather than strand it', async () => {
    const { deps, releaseHold } = makeDeps({ writeSettle: vi.fn(async () => 'superseded' as const) });

    const run = await meter(deps);

    expect(run.watermarkSuperseded).toBe(1);
    expect(releaseHold).toHaveBeenCalledWith('hold-next');
  });

  it('given a wake opened the window while the STAMP path was gating, should release that hold too', async () => {
    const { deps, releaseHold } = makeDeps({
      listRunningApps: async () => [runningApp({ awakeBilledThrough: null })],
      stampWindowStart: vi.fn(async () => 'superseded' as const),
    });

    const run = await meter(deps);

    assert({
      given: 'a row that acquired a window between the read and the stamp',
      should: 'not count it stamped, and return the unused reservation',
      actual: { stamped: run.stamped, superseded: run.watermarkSuperseded, released: releaseHold.mock.calls },
      expected: { stamped: 0, superseded: 1, released: [['hold-next']] },
    });
  });

  it('uses ONE clock for the whole tick, so two rows cannot overlap at the seam', async () => {
    const now = vi.fn(() => NOW);
    const { deps } = makeDeps({
      now,
      listRunningApps: async () => [runningApp({ id: 'a' }), runningApp({ id: 'b' }), runningApp({ id: 'c' })],
    });

    await meter(deps);

    expect(now).toHaveBeenCalledTimes(1);
  });
});


describe('meterAwakePublishedApps — the per-app daily awake cap', () => {
  it('given this settle carries the app PAST its daily budget, should advance the watermark THEN park it', async () => {
    // The span is already charged when the cap is judged, and `stopPublishedApp`
    // re-reads the row and settles from whatever watermark it finds — so parking on
    // the stale one would bill this same span a second time on every cap park.
    const order: string[] = [];
    const { deps, park, writeSettle } = makeDeps({
      dailyAwakeCapSeconds: () => 900,
      listRunningApps: async () => [runningApp({ awakeSecondsDay: '2026-08-20', awakeSecondsToday: 600 })],
    });
    writeSettle.mockImplementation(async () => {
      order.push('advance');
      return 'advanced' as const;
    });
    park.mockImplementation(async () => {
      order.push('park');
    });

    const run = await meter(deps);

    assert({
      given: '600s already spent today and a 600s settle against a 900s budget',
      should: 'record the charge, then park under the cap’s own counter',
      actual: { cappedParked: run.cappedParked, parked: run.parked, order },
      expected: { cappedParked: 1, parked: 0, order: ['advance', 'park'] },
    });
    expect(park).toHaveBeenCalledWith('app-1', 'daily_cap');
  });

  it('given the settle leaves the app UNDER its budget, should keep it running', async () => {
    const { deps, park } = makeDeps({
      dailyAwakeCapSeconds: () => 43_200,
      listRunningApps: async () => [runningApp({ awakeSecondsDay: '2026-08-20', awakeSecondsToday: 600 })],
    });

    const run = await meter(deps);

    expect(park).not.toHaveBeenCalled();
    assert({
      given: '1200s of a 43200s budget spent',
      should: 'settle and leave the app alone',
      actual: { settled: run.settled, cappedParked: run.cappedParked },
      expected: { settled: 1, cappedParked: 0 },
    });
  });

  it('given YESTERDAY’s counter is over the budget, should NOT park — a stale counter is not today’s spend', async () => {
    // The regression: reading a stale counter as today's parks every busy app the
    // morning after it was busy, permanently.
    const { deps, park } = makeDeps({
      dailyAwakeCapSeconds: () => 900,
      listRunningApps: async () => [runningApp({ awakeSecondsDay: '2026-08-19', awakeSecondsToday: 86_400 })],
    });

    const run = await meter(deps);

    expect(park).not.toHaveBeenCalled();
    expect(run.cappedParked).toBe(0);
  });

  it('NEVER caps a dedicated app, however long it has been awake', async () => {
    // The flat-rate tier is sold as always-on, and `parked` is metered-only at the
    // database — parking one is an outage of something somebody pays to keep up.
    const { deps, park } = makeDeps({
      dailyAwakeCapSeconds: () => 60,
      listRunningApps: async () => [
        runningApp({ tier: 'dedicated', awakeSecondsDay: '2026-08-20', awakeSecondsToday: 86_400 }),
      ],
    });

    const run = await meter(deps);

    expect(park).not.toHaveBeenCalled();
    expect(run.settled).toBe(1);
  });

  it('given the cap disabled, should never park however many seconds are counted', async () => {
    const { deps, park } = makeDeps({
      dailyAwakeCapSeconds: () => 0,
      listRunningApps: async () => [runningApp({ awakeSecondsDay: '2026-08-20', awakeSecondsToday: 999_999 })],
    });

    await meter(deps);

    expect(park).not.toHaveBeenCalled();
  });

  it('passes the settled seconds to the watermark write, so the counter and the charge agree', async () => {
    // Seconds charged but not counted are seconds the cap cannot see.
    const { deps, writeSettle } = makeDeps();

    await meter(deps);

    expect(writeSettle).toHaveBeenCalledWith(expect.objectContaining({ billedSeconds: 600 }));
  });
});
