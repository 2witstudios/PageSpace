import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assert } from '../../sandbox/__tests__/riteway';

/**
 * A db double that records every UPDATE's SET payload.
 *
 * `.where()` is a thenable that ALSO carries `.returning()`, because the module
 * under test awaits `.where(...)` directly for the writes whose result it does not
 * read, and chains `.returning()` for the wake's guarded write.
 */
const mockDb = vi.hoisted(() => {
  const state: {
    selectRows: unknown[];
    updateSets: Array<Record<string, unknown>>;
    returningRows: unknown[][];
  } = { selectRows: [], updateSets: [], returningRows: [] };

  const db = {
    __state: state,
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => state.selectRows }) }),
    }),
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        state.updateSets.push(payload);
        const result = {
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
          returning: async () => state.returningRows.shift() ?? [],
        };
        return { where: () => result };
      },
    }),
  };
  return db;
});
vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
// PARTIAL: `credit-gate` is pulled in transitively and builds a `sql` template at
// module load, so the real operators have to stay available.
vi.mock('@pagespace/db/operators', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  and: (...a: unknown[]) => ({ op: 'and', a }),
  eq: (a: unknown, b: unknown) => ({ op: 'eq', a, b }),
}));

const mockRecordBoundary = vi.hoisted(() => vi.fn(async () => true));
const mockMirror = vi.hoisted(() => vi.fn(async () => ({ boundaries: 0, inserted: 0, failed: false })));
const mockFindStop = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../app-machine-events', () => ({
  recordOrchestratorBoundary: mockRecordBoundary,
  mirrorFlyMachineEvents: mockMirror,
  findStopBoundarySince: mockFindStop,
}));

import {
  wakePublishedApp,
  stopPublishedApp,
  closeAppWindowAtBoundary,
  passThroughSettleLock,
  serializeUnderMeterLock,
  DAILY_CAP_PARK_REASON,
  defaultAppLifecycleMeteringDeps,
  type AppLifecycleMeteringDeps,
} from '../app-lifecycle-metering';
import { METER_AWAKE_LOCK_KEY } from '../app-metering-core';
import { resolveDailyAwakeSecondsCap } from '../app-hosting-env';
import type { PublishedApp } from '@pagespace/db/schema/published-apps';

const NOW = new Date('2026-08-20T12:00:00.000Z');
const WOKEN_AT = new Date('2026-08-20T11:00:00.000Z');

function appRow(over: Partial<PublishedApp> = {}): PublishedApp {
  return {
    id: 'app-1',
    driveId: 'drive-1',
    flyAppName: 'pgs-app-1',
    machineId: 'machine-1',
    status: 'stopped',
    tier: 'metered',
    imageDigest: 'sha256:abc',
    lastWakeAt: null,
    lastStopAt: null,
    awakeBilledThrough: null,
    awakeHoldId: null,
    ...over,
  } as unknown as PublishedApp;
}

function makeDeps(over: Partial<AppLifecycleMeteringDeps> = {}): {
  deps: AppLifecycleMeteringDeps;
  gate: ReturnType<typeof vi.fn>;
  trackUsage: ReturnType<typeof vi.fn>;
  releaseHold: ReturnType<typeof vi.fn>;
  startMachine: ReturnType<typeof vi.fn>;
  stopMachine: ReturnType<typeof vi.fn>;
  serializeSettle: ReturnType<typeof vi.fn>;
} {
  const gate = vi.fn(async () => ({ allowed: true, holdId: 'hold-1' }));
  const trackUsage = vi.fn(async () => ({ persisted: true, creditsSettled: true }));
  const releaseHold = vi.fn(async () => {});
  const startMachine = vi.fn(async () => {});
  const stopMachine = vi.fn(async () => {});
  // Acquires by default. A test that wants the meter to be mid-tick overrides it
  // with `{ locked: false }`.
  const serializeSettle = vi.fn(async (fn: () => Promise<unknown>) => ({ locked: true as const, result: await fn() }));
  const deps: AppLifecycleMeteringDeps = {
    isEnabled: () => true,
    billing: {
      resolvePayerId: async () => 'payer-1',
      gate,
      trackUsage,
      releaseHold,
    },
    startMachine,
    stopMachine,
    listMachineEvents: async () => [],
    serializeSettle: serializeSettle as unknown as AppLifecycleMeteringDeps['serializeSettle'],
    dailyAwakeCapSeconds: () => 0,
    now: () => NOW,
    ...over,
  };
  return { deps, gate, trackUsage, releaseHold, startMachine, stopMachine, serializeSettle };
}

function seed(row: PublishedApp | null, returning: unknown[][] = []) {
  mockDb.__state.selectRows = row ? [row] : [];
  mockDb.__state.updateSets = [];
  mockDb.__state.returningRows = returning;
}

beforeEach(() => {
  mockRecordBoundary.mockClear();
  mockMirror.mockClear();
  mockFindStop.mockClear();
  mockDb.__state.updateSets = [];
  mockDb.__state.returningRows = [];
});

describe('wakePublishedApp', () => {
  it('given the kill switch is off, should refuse and read NOTHING', async () => {
    const { deps, gate } = makeDeps({ isEnabled: () => false });
    seed(appRow());

    assert({
      given: 'APP_HOSTING_ENABLED unset',
      should: 'refuse as disabled without gating anyone',
      actual: await wakePublishedApp('app-1', deps),
      expected: { outcome: 'refused', reason: 'disabled' },
    });
    expect(gate).not.toHaveBeenCalled();
  });

  it('GATES BEFORE STARTING the machine — the whole of hosting’s credit enforcement', async () => {
    const { deps, gate, startMachine } = makeDeps();
    gate.mockResolvedValue({ allowed: false, reason: 'insufficient_credits' });
    seed(appRow());

    const result = await wakePublishedApp('app-1', deps);

    assert({
      given: 'a payer the gate refuses',
      should: 'park the app and never start a machine',
      actual: { result, started: startMachine.mock.calls.length },
      expected: { result: { outcome: 'parked', reason: 'insufficient_credits' }, started: 0 },
    });
    expect(mockDb.__state.updateSets[0]).toMatchObject({ status: 'parked' });
  });

  it('given an unresolvable drive, should refuse the wake rather than bill somebody else', async () => {
    const { deps, gate, startMachine } = makeDeps();
    deps.billing.resolvePayerId = async () => null;
    seed(appRow());

    assert({
      given: 'a published app whose owning drive cannot be resolved',
      should: 'refuse without gating or starting',
      actual: await wakePublishedApp('app-1', deps),
      expected: { outcome: 'refused', reason: 'unresolved_payer' },
    });
    expect(gate).not.toHaveBeenCalled();
    expect(startMachine).not.toHaveBeenCalled();
  });

  it('opens the awake window at the wake instant and records the boundary', async () => {
    const { deps } = makeDeps();
    const row = appRow();
    seed(row, [[{ ...row, status: 'running' }]]);

    const result = await wakePublishedApp('app-1', deps);

    expect(result.outcome).toBe('woken');
    assert({
      given: 'a successful wake',
      should: 'stamp the boundary and the watermark at the same instant, carrying the hold',
      actual: mockDb.__state.updateSets[0],
      expected: {
        status: 'running',
        lastWakeAt: NOW,
        awakeBilledThrough: NOW,
        awakeHoldId: 'hold-1',
      },
    });
    expect(mockRecordBoundary).toHaveBeenCalledWith(
      { publishedAppId: 'app-1', flyAppName: 'pgs-app-1', machineId: 'machine-1' },
      'start',
      NOW,
    );
  });

  it('does NOT gate a dedicated wake — the flat monthly price is what pays for it', async () => {
    // Running the gate on a dedicated app is worse than pointless: an exhausted
    // payer would be refused a wake and then sent to `parkPublishedApp`, which the
    // status machine correctly refuses (`parked_is_metered_only`) — leaving an app
    // that is neither woken nor parked, that the customer is paying for.
    const { deps, gate, startMachine } = makeDeps();
    const row = appRow({ tier: 'dedicated' });
    seed(row, [[{ ...row, status: 'running' }]]);

    const result = await wakePublishedApp('app-1', deps);

    expect(result.outcome).toBe('woken');
    expect(gate, 'a dedicated wake must not consult the credit gate').not.toHaveBeenCalled();
    expect(startMachine).toHaveBeenCalled();
  });

  it('opens NO billing window for a dedicated wake, only a boundary', async () => {
    // NULL means "no awake window is open", which for a dedicated app is the
    // literal truth: nothing accrues, nothing settles, nothing closes it. Stamping
    // it anyway would leave every dedicated row carrying what looks like an
    // unbilled liability and is not one.
    const { deps } = makeDeps();
    const row = appRow({ tier: 'dedicated' });
    seed(row, [[{ ...row, status: 'running' }]]);

    await wakePublishedApp('app-1', deps);

    assert({
      given: 'a dedicated wake',
      should: 'stamp the reconcile boundary but no watermark and no hold',
      actual: mockDb.__state.updateSets[0],
      expected: {
        status: 'running',
        lastWakeAt: NOW,
        awakeBilledThrough: null,
        awakeHoldId: null,
      },
    });
  });

  it('does not even resolve a payer for a dedicated wake', async () => {
    // The payer lookup exists to answer "who is charged", and nobody is charged
    // per-second here — so an app whose drive is mid-delete still wakes.
    const resolvePayerId = vi.fn(async () => null);
    const { deps } = makeDeps();
    const row = appRow({ tier: 'dedicated' });
    seed(row, [[{ ...row, status: 'running' }]]);

    const result = await wakePublishedApp('app-1', { ...deps, billing: { ...deps.billing, resolvePayerId } });

    expect(resolvePayerId).not.toHaveBeenCalled();
    expect(result.outcome).toBe('woken');
  });

  it('given Fly refuses the start, should release the hold and stamp NOTHING', async () => {
    // Nothing started, so nothing may be billed — and a stranded hold would
    // suppress the payer's own spendable balance for its whole TTL.
    const { deps, releaseHold, startMachine } = makeDeps();
    startMachine.mockRejectedValue(new Error('capacity'));
    seed(appRow());

    const result = await wakePublishedApp('app-1', deps);

    expect(result).toEqual({ outcome: 'start_failed', error: 'capacity' });
    expect(releaseHold).toHaveBeenCalledWith('hold-1');
    expect(mockDb.__state.updateSets).toEqual([]);
  });

  it('given a concurrent wake won the race, should release ITS OWN hold and not overwrite the winner’s window', async () => {
    // The status-guarded UPDATE matches no row for the loser. Overwriting the
    // winner's window start with a later one would silently forgive the seconds
    // in between.
    const { deps, releaseHold } = makeDeps();
    seed(appRow(), [[]]);

    assert({
      given: 'two requests racing the same cold app',
      should: 'refuse the loser and return its reservation',
      actual: await wakePublishedApp('app-1', deps),
      expected: { outcome: 'refused', reason: 'not_wakeable' },
    });
    expect(releaseHold).toHaveBeenCalledWith('hold-1');
  });

  it('refuses a row with no machine, and a row the status machine will not move', async () => {
    const { deps } = makeDeps();

    seed(appRow({ machineId: null }));
    expect(await wakePublishedApp('app-1', deps)).toEqual({ outcome: 'refused', reason: 'no_machine' });

    seed(appRow({ status: 'running' }));
    expect(await wakePublishedApp('app-1', deps)).toEqual({ outcome: 'refused', reason: 'not_wakeable' });

    seed(null);
    expect(await wakePublishedApp('app-1', deps)).toEqual({ outcome: 'refused', reason: 'not_found' });
  });
});

/** A row mid-awake-window: woken an hour before NOW, watermark at the wake. */
const running = (over: Partial<PublishedApp> = {}) =>
  appRow({ status: 'running', lastWakeAt: WOKEN_AT, awakeBilledThrough: WOKEN_AT, awakeHoldId: 'hold-1', ...over });

describe('wakePublishedApp — the abandoned tail a failed close left behind', () => {
  // `closeStatusOnly` preserves `awakeBilledThrough` when a final settle does not
  // land, but the awake meter reads `status = 'running'` rows ONLY, so nothing
  // revisits a stopped row — and the wake's own UPDATE resets that watermark to
  // `wokenAt`. Without this step the preserved span is silently discarded at the
  // next wake, which makes the failed-settle path's "the window stays open"
  // promise false exactly where it matters most.

  const abandoned = () =>
    appRow({
      status: 'stopped',
      awakeBilledThrough: new Date('2026-08-20T10:00:00.000Z'),
      lastStopAt: new Date('2026-08-20T10:10:00.000Z'),
      awakeHoldId: 'hold-stranded',
    });

  it('bills the stranded span at the boundary the window REALLY ended on, not up to now', async () => {
    const { deps, trackUsage } = makeDeps();
    seed(abandoned(), [[appRow({ status: 'running' })]]);

    await wakePublishedApp('app-1', deps);

    // 10:00 -> 10:10 is 600s. Billing to `now` (12:00) would charge 7200s — two
    // hours of a machine that was STOPPED.
    expect(trackUsage).toHaveBeenCalledWith({
      payerId: 'payer-1',
      holdId: 'hold-stranded',
      activeSeconds: 600,
      driveId: 'drive-1',
      publishedAppId: 'app-1',
    });
  });

  it('does NOT bill a tail on a live (running) row — that is an open window, not an abandoned one', async () => {
    const { deps, trackUsage } = makeDeps();
    seed(
      appRow({
        status: 'running',
        awakeBilledThrough: new Date('2026-08-20T10:00:00.000Z'),
        lastStopAt: new Date('2026-08-20T10:10:00.000Z'),
      }),
      [[appRow({ status: 'running' })]],
    );

    await wakePublishedApp('app-1', deps);

    expect(trackUsage).not.toHaveBeenCalled();
  });

  it('returns the stranded reservation when the tail prices to nothing', async () => {
    const { deps, trackUsage, releaseHold } = makeDeps();
    seed(
      appRow({
        status: 'stopped',
        awakeBilledThrough: new Date('2026-08-20T10:10:00.000Z'),
        lastStopAt: new Date('2026-08-20T10:10:00.000Z'), // zero-length window
        awakeHoldId: 'hold-stranded',
      }),
      [[appRow({ status: 'running' })]],
    );

    await wakePublishedApp('app-1', deps);

    expect(trackUsage).not.toHaveBeenCalled();
    expect(releaseHold).toHaveBeenCalledWith('hold-stranded');
  });

  it('NEVER blocks the wake, even when the tail settle fails outright', async () => {
    // A billing failure must not leave an app unservable. The span is lost at this
    // point — two independent failures at two separate moments — and said so.
    const { deps, trackUsage, startMachine } = makeDeps();
    trackUsage.mockRejectedValue(new Error('ledger down'));
    seed(abandoned(), [[appRow({ status: 'running' })]]);

    const result = await wakePublishedApp('app-1', deps);

    expect(startMachine).toHaveBeenCalled();
    expect(result.outcome).toBe('woken');
  });

  it('does not bill anyone when the gate REFUSES — a parked wake moves no money', async () => {
    const { deps, gate, trackUsage } = makeDeps();
    gate.mockResolvedValue({ allowed: false, reason: 'insufficient_credits' });
    seed(abandoned());

    await wakePublishedApp('app-1', deps);

    expect(trackUsage).not.toHaveBeenCalled();
  });
});

describe('stopPublishedApp', () => {

  it('settles the tail of the window against the wake’s hold and closes it', async () => {
    const { deps, trackUsage } = makeDeps();
    seed(running());

    const result = await stopPublishedApp('app-1', 'idle', deps);

    assert({
      given: 'an app awake for an hour',
      should: 'bill exactly that hour',
      actual: { outcome: result.outcome, billed: result.outcome === 'stopped' ? result.billedSeconds : null },
      expected: { outcome: 'stopped', billed: 3600 },
    });
    expect(trackUsage).toHaveBeenCalledWith({
      payerId: 'payer-1',
      holdId: 'hold-1',
      activeSeconds: 3600,
      driveId: 'drive-1',
      publishedAppId: 'app-1',
    });
    const set = mockDb.__state.updateSets[0] as Record<string, unknown>;
    assert({
      given: 'a settled stop',
      should: 'close the window, stamp the stop boundary and count the day’s seconds',
      actual: {
        status: set.status,
        lastStopAt: set.lastStopAt,
        awakeBilledThrough: set.awakeBilledThrough,
        awakeHoldId: set.awakeHoldId,
        awakeSecondsDay: set.awakeSecondsDay,
        // The increment itself is a SQL CASE (the day's reset happens in the
        // statement, never from a read-then-write) — asserting it is present is
        // what this level can honestly claim; the arithmetic is covered by
        // `planDailyAwakeCap` and by the integration test.
        countsSeconds: set.awakeSecondsToday !== undefined,
      },
      expected: {
        status: 'stopped',
        lastStopAt: NOW,
        awakeBilledThrough: null,
        awakeHoldId: null,
        awakeSecondsDay: '2026-08-20',
        countsSeconds: true,
      },
    });
  });

  it('MIRRORS THE BOUNDARY BEFORE THE MONEY, so a crash mid-settle is self-healing', async () => {
    const order: string[] = [];
    mockRecordBoundary.mockImplementation(async () => {
      order.push('mirror');
      return true;
    });
    const { deps, trackUsage } = makeDeps();
    trackUsage.mockImplementation(async () => {
      order.push('settle');
    });
    seed(running());

    await stopPublishedApp('app-1', 'idle', deps);

    assert({
      given: 'a stop that settles',
      should: 'write the boundary before charging',
      actual: order,
      expected: ['mirror', 'settle'],
    });
  });

  it('given `insolvent`, should land in PARKED rather than stopped', async () => {
    // The difference is load-bearing downstream: a stopped app wakes on the next
    // request and a parked one does not.
    const { deps } = makeDeps();
    seed(running());

    const result = await stopPublishedApp('app-1', 'insolvent', deps);

    expect(result).toMatchObject({ outcome: 'stopped', status: 'parked' });
    expect(mockDb.__state.updateSets[0]).toMatchObject({ status: 'parked' });
  });

  it('given Fly refuses the stop, should leave the window OPEN and still billing', async () => {
    // A failed stop very likely means the machine is still running and still
    // costing money; closing the window would stop billing time genuinely used.
    const { deps, stopMachine, trackUsage } = makeDeps();
    stopMachine.mockRejectedValue(new Error('flaps 500'));
    seed(running());

    expect(await stopPublishedApp('app-1', 'idle', deps)).toEqual({
      outcome: 'stop_failed',
      error: 'flaps 500',
    });
    expect(trackUsage).not.toHaveBeenCalled();
    expect(mockDb.__state.updateSets).toEqual([]);
  });

  it('given the settle throws, should close the STATUS but keep the window open for a retry', async () => {
    // Closing it would silently lose the app's last awake window; leaving the row
    // `running` over a stopped machine would be worse still.
    const { deps, trackUsage } = makeDeps();
    trackUsage.mockRejectedValue(new Error('ledger down'));
    seed(running());

    const result = await stopPublishedApp('app-1', 'idle', deps);

    expect(result).toMatchObject({ outcome: 'stopped', billedSeconds: 0 });
    const written = mockDb.__state.updateSets[0];
    assert({
      given: 'a failed settle',
      should: 'move the status without clearing the billing watermark',
      actual: {
        status: written.status,
        clearedWatermark: 'awakeBilledThrough' in written,
      },
      expected: { status: 'stopped', clearedWatermark: false },
    });
  });

  // ── The persistence CONTRACT (issue: trackUsage must report its outcome) ────
  // The default binding runs through `AIMonitoring.trackUsage`, which never throws.
  // Before it reported an outcome, a settle whose `ai_usage_logs` write failed
  // RESOLVED — so the test above covered only a deps-level throw and the app's last
  // awake window was silently closed over lost spend on the real path.

  it('given a settle that resolves WITHOUT persisting, should close the STATUS but keep the window open for a retry', async () => {
    const { deps, trackUsage } = makeDeps();
    trackUsage.mockResolvedValue({ persisted: false, creditsSettled: false });
    seed(running());

    const result = await stopPublishedApp('app-1', 'idle', deps);

    expect(result).toMatchObject({ outcome: 'stopped', billedSeconds: 0 });
    const written = mockDb.__state.updateSets[0];
    assert({
      given: 'a settle that resolved but wrote no usage row',
      should: 'move the status without clearing the billing watermark',
      actual: { status: written.status, clearedWatermark: 'awakeBilledThrough' in written },
      expected: { status: 'stopped', clearedWatermark: false },
    });
  });

  it('given a PERSISTED settle whose ledger settle was deferred, should still CLOSE the window (the backfill cron owns that charge)', async () => {
    // Reopening the window here would re-bill a span the credit backfill cron is
    // already collecting from the usage row.
    const { deps, trackUsage } = makeDeps();
    trackUsage.mockResolvedValue({ persisted: true, creditsSettled: false });
    seed(running());

    const result = await stopPublishedApp('app-1', 'idle', deps);

    const written = mockDb.__state.updateSets[0];
    assert({
      given: 'a persisted settle whose ledger claim was deferred to the backfill cron',
      should: 'bill the span and close the window exactly as a fully settled charge would',
      actual: {
        billedSeconds: result.outcome === 'stopped' ? result.billedSeconds : -1,
        clearedWatermark: 'awakeBilledThrough' in written,
      },
      expected: { billedSeconds: 3600, clearedWatermark: true },
    });
  });

  it('given an unresolvable drive at settle time, should skip the charge and RELEASE the hold', async () => {
    const { deps, trackUsage, releaseHold } = makeDeps();
    deps.billing.resolvePayerId = async () => null;
    seed(running());

    await stopPublishedApp('app-1', 'idle', deps);

    expect(trackUsage).not.toHaveBeenCalled();
    expect(releaseHold).toHaveBeenCalledWith('hold-1');
  });

  it('given nothing to bill, should RELEASE the hold rather than settle against it', async () => {
    const { deps, trackUsage, releaseHold } = makeDeps();
    // Watermark already at `now` — a stop immediately after a settle.
    seed(appRow({ status: 'running', lastWakeAt: WOKEN_AT, awakeBilledThrough: NOW, awakeHoldId: 'hold-1' }));

    await stopPublishedApp('app-1', 'idle', deps);

    expect(trackUsage).not.toHaveBeenCalled();
    expect(releaseHold).toHaveBeenCalledWith('hold-1');
  });

  it('refuses to stop a row that is not running', async () => {
    const { deps } = makeDeps();
    seed(appRow({ status: 'stopped' }));
    expect(await stopPublishedApp('app-1', 'idle', deps)).toEqual({
      outcome: 'refused',
      reason: 'not_running',
    });
  });
});

describe('closeAppWindowAtBoundary', () => {
  it('bills only up to the REAL stop boundary, never to now', async () => {
    // The repair path: a stop that happened and whose status write was lost.
    // Billing through `now` would charge for the span between a stop we did not
    // record and the moment we noticed it.
    const { deps, trackUsage } = makeDeps();
    const boundary = new Date(WOKEN_AT.getTime() + 600_000);
    const row = appRow({
      status: 'running',
      lastWakeAt: WOKEN_AT,
      awakeBilledThrough: WOKEN_AT,
      awakeHoldId: 'hold-1',
    });
    seed(row);

    const result = await closeAppWindowAtBoundary(row, boundary, deps);

    assert({
      given: 'a mirrored stop ten minutes into an hour-old window',
      should: 'bill ten minutes, not the hour to now',
      actual: { billed: result.billedSeconds, failed: result.failed },
      expected: { billed: 600, failed: false },
    });
    expect(trackUsage.mock.calls[0][0].activeSeconds).toBe(600);
    expect(mockDb.__state.updateSets[0]).toMatchObject({
      lastStopAt: boundary,
      awakeBilledThrough: null,
    });
  });
});


describe('stopPublishedApp — the awake meter’s advisory lock', () => {
  it('runs the WHOLE stop under the meter’s lock: the read, the Fly call and the settle', async () => {
    // The double-charge this prevents is created by the READ — a stop and a
    // heartbeat pricing the same window from two snapshots — so a lock taken after
    // the row is read would protect nothing. Asserted by ordering rather than by
    // presence: the lock must already be held when the first thing happens.
    const order: string[] = [];
    const { deps, stopMachine, trackUsage } = makeDeps();
    stopMachine.mockImplementation(async () => {
      order.push('fly-stop');
    });
    trackUsage.mockImplementation(async () => {
      order.push('settle');
    });
    const serializeSettle: AppLifecycleMeteringDeps['serializeSettle'] = async (fn) => {
      order.push('lock');
      const result = await fn();
      order.push('unlock');
      return { locked: true, result };
    };
    seed(running());

    await stopPublishedApp('app-1', 'idle', { ...deps, serializeSettle });

    assert({
      given: 'an idle stop',
      should: 'hold the meter lock across the Fly stop AND the settle',
      actual: order,
      expected: ['lock', 'fly-stop', 'settle', 'unlock'],
    });
  });

  it('given the lock is held by a heartbeat tick, should answer lock_busy having read NOTHING', async () => {
    // Nothing was read, stopped or billed, and the row is still `running` — so the
    // next reaper tick finds it again. That self-correction is why this is a clean
    // outcome rather than an error.
    const { deps, stopMachine, trackUsage } = makeDeps({
      serializeSettle: async () => ({ locked: false }),
    });
    seed(running());

    const result = await stopPublishedApp('app-1', 'idle', deps);

    assert({
      given: 'the awake meter mid-tick',
      should: 'refuse as lock_busy without stopping a machine or billing anything',
      actual: {
        outcome: result.outcome,
        flyCalls: stopMachine.mock.calls.length,
        settles: trackUsage.mock.calls.length,
        writes: mockDb.__state.updateSets.length,
      },
      expected: { outcome: 'lock_busy', flyCalls: 0, settles: 0, writes: 0 },
    });
  });

  it('checks the kill switch BEFORE taking the lock — a dark deployment must not touch the pool', async () => {
    const serializeSettle = vi.fn();
    const { deps } = makeDeps({
      isEnabled: () => false,
      serializeSettle: serializeSettle as unknown as AppLifecycleMeteringDeps['serializeSettle'],
    });
    seed(running());

    const result = await stopPublishedApp('app-1', 'idle', deps);

    expect(serializeSettle).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'refused', reason: 'disabled' });
  });

  it('serializeUnderMeterLock takes the awake meter’s OWN key, not one of its own', async () => {
    // The binding requirement from PR #2493: a stop-settle and a heartbeat-settle
    // must serialize. A key of this module's own would satisfy the type and defeat
    // the entire point.
    const query = vi.fn(async (text: string, _params?: unknown[]) =>
      text.includes('pg_try_advisory_lock') ? { rows: [{ acquired: true }] } : { rows: [] },
    );
    const release = vi.fn();
    const run = await serializeUnderMeterLock({ connect: async () => ({ query, release }) })(async () => 'done');

    assert({
      given: 'a real advisory-lock pool',
      should: 'lock the meter’s key and run the body',
      actual: {
        key: (query.mock.calls[0]?.[1] as string[] | undefined)?.[0],
        result: run.locked ? run.result : null,
      },
      expected: { key: METER_AWAKE_LOCK_KEY, result: 'done' },
    });
  });

  it('passThroughSettleLock runs the body immediately — for the caller already inside the lock', async () => {
    // The heartbeat's park runs inside the meter's locked region. A second
    // acquisition would not deadlock (the try-lock does not block); it would answer
    // lock_busy and SKIP the park while the tick reported success.
    const body = vi.fn(async () => 'ran');

    assert({
      given: 'a caller that already holds the lock',
      should: 'run the body without taking anything',
      actual: await passThroughSettleLock(body),
      expected: { locked: true, result: 'ran' },
    });
  });

  it('the default deps bind the cap resolver and a real serializer', () => {
    // Every other test in this file injects its own deps, so the object that
    // actually runs in production is asserted by nothing otherwise.
    expect(defaultAppLifecycleMeteringDeps.dailyAwakeCapSeconds).toBe(resolveDailyAwakeSecondsCap);
    expect(typeof defaultAppLifecycleMeteringDeps.serializeSettle).toBe('function');
  });
});

describe('the daily awake cap', () => {
  it('given an app that has spent its budget today, should REFUSE THE WAKE and park it — before Fly is called', async () => {
    // The same enforcement shape as the credit gate: park, do not start. There is
    // nothing to claw back from a machine that was never woken.
    const { deps, startMachine, gate } = makeDeps({ dailyAwakeCapSeconds: () => 43_200 });
    seed(appRow({ awakeSecondsDay: '2026-08-20', awakeSecondsToday: 43_200 }));

    const result = await wakePublishedApp('app-1', deps);

    assert({
      given: 'a metered app already at its daily budget',
      should: 'park it without starting a machine or reserving credit',
      actual: {
        result,
        started: startMachine.mock.calls.length,
        gated: gate.mock.calls.length,
        status: (mockDb.__state.updateSets[0] as Record<string, unknown>)?.status,
      },
      expected: {
        result: { outcome: 'parked', reason: DAILY_CAP_PARK_REASON },
        started: 0,
        gated: 0,
        status: 'parked',
      },
    });
  });

  it('given YESTERDAY’s counter at the budget, should still wake — a stale counter is not today’s spend', async () => {
    // The regression: reading a stale counter as today's parks every busy app once
    // a day, permanently, the morning after it was busy.
    const { deps, startMachine } = makeDeps({ dailyAwakeCapSeconds: () => 43_200 });
    seed(appRow({ awakeSecondsDay: '2026-08-19', awakeSecondsToday: 86_400 }), [[appRow({ status: 'running' })]]);

    const result = await wakePublishedApp('app-1', deps);

    expect(startMachine).toHaveBeenCalledWith('pgs-app-1', 'machine-1');
    expect(result.outcome).toBe('woken');
  });

  it('given the cap disabled, should never consult the counter at all', async () => {
    const { deps, startMachine } = makeDeps({ dailyAwakeCapSeconds: () => 0 });
    seed(appRow({ awakeSecondsDay: '2026-08-20', awakeSecondsToday: 999_999 }), [[appRow({ status: 'running' })]]);

    expect((await wakePublishedApp('app-1', deps)).outcome).toBe('woken');
    expect(startMachine).toHaveBeenCalled();
  });

  it('a `daily_cap` stop PARKS the app and records why on the row', async () => {
    // `lastError` is the owner-facing half of the notification: the publish surface
    // already reads it to answer "why is my app not serving". There is no
    // NotificationType for this state and adding one is UI work for a later PR.
    const { deps } = makeDeps();
    seed(running());

    const result = await stopPublishedApp('app-1', 'daily_cap', deps);

    assert({
      given: 'a stop for exceeding the daily budget',
      should: 'land in parked, carrying the reason',
      actual: {
        status: result.outcome === 'stopped' ? result.status : null,
        set: {
          status: (mockDb.__state.updateSets[0] as Record<string, unknown>).status,
          lastError: (mockDb.__state.updateSets[0] as Record<string, unknown>).lastError,
        },
      },
      expected: {
        status: 'parked',
        set: { status: 'parked', lastError: `parked: ${DAILY_CAP_PARK_REASON}` },
      },
    });
  });

  it('an `idle` stop leaves the app STOPPED with no error — idle is not enforcement', async () => {
    // The difference is load-bearing downstream: a stopped app wakes on the next
    // request and a parked one does not.
    const { deps } = makeDeps();
    seed(running());

    const result = await stopPublishedApp('app-1', 'idle', deps);

    assert({
      given: 'an idle stop',
      should: 'stop the app without parking it or writing an error',
      actual: {
        status: result.outcome === 'stopped' ? result.status : null,
        lastError: (mockDb.__state.updateSets[0] as Record<string, unknown>).lastError,
      },
      expected: { status: 'stopped', lastError: undefined },
    });
  });

  it('a zero-second settle does NOT touch the day counter', async () => {
    // Advancing `awakeSecondsDay` on a settle that billed nothing would roll a row
    // onto a day it spent no seconds in — and the CHECK forbids a counter with no
    // day, so the pair has to move together or not at all.
    const { deps } = makeDeps();
    // A window opened at NOW: no elapsed time, so `planAwakeSettle` skips.
    seed(running({ awakeBilledThrough: NOW }));

    await stopPublishedApp('app-1', 'idle', deps);

    const set = mockDb.__state.updateSets[0] as Record<string, unknown>;
    assert({
      given: 'a stop with nothing to bill',
      should: 'close the window without writing a day or a count',
      actual: { day: set.awakeSecondsDay, seconds: set.awakeSecondsToday, status: set.status },
      expected: { day: undefined, seconds: undefined, status: 'stopped' },
    });
  });
});

describe('the wake gate’s in-flight bound', () => {
  it('given the gate refuses on CONCURRENCY, should park and never start a machine', async () => {
    // `defaultAppBillingDeps.gate` passes `maxInFlight: PUBLISHED_APP_MAX_INFLIGHT`
    // to `canConsumeAI` (asserted in app-billing.test.ts); this is the other half —
    // the wake honours that refusal exactly as it honours an empty balance, so a
    // wake storm against one payer cannot fan out into an unbounded number of
    // concurrently-reserved machines.
    const { deps, startMachine } = makeDeps();
    deps.billing.gate = async () => ({ allowed: false, reason: 'max_in_flight' });
    seed(appRow());

    const result = await wakePublishedApp('app-1', deps);

    assert({
      given: 'a payer already at the in-flight reservation cap',
      should: 'park the app with the gate’s own reason and start nothing',
      actual: { result, started: startMachine.mock.calls.length },
      expected: { result: { outcome: 'parked', reason: 'max_in_flight' }, started: 0 },
    });
  });
});


describe('stopPublishedApp — the idle re-check under the lock', () => {
  it('given the app was SERVED after the reaper’s scan, should refuse and stop nothing', async () => {
    // The scan and the stop can be minutes apart on a large fleet, and the router
    // stamps `lastHitAt` in between. Without the re-check, a machine that took a
    // visitor thirty seconds ago is stopped on the strength of a snapshot that
    // predates them.
    const { deps, stopMachine, trackUsage } = makeDeps();
    const cutoff = new Date(NOW.getTime() - 900_000);
    seed(running({ lastHitAt: new Date(NOW.getTime() - 30_000) }));

    const result = await stopPublishedApp('app-1', 'idle', deps, { idleCutoff: cutoff });

    assert({
      given: 'a hit stamped after the cutoff this stop was asked about',
      should: 'refuse as became_active without calling Fly or billing anything',
      actual: {
        result,
        flyCalls: stopMachine.mock.calls.length,
        settles: trackUsage.mock.calls.length,
      },
      expected: { result: { outcome: 'refused', reason: 'became_active' }, flyCalls: 0, settles: 0 },
    });
  });

  it('given the row is still quiet, should stop it', async () => {
    const { deps, stopMachine } = makeDeps();
    seed(running({ lastHitAt: new Date(NOW.getTime() - 1_800_000) }));

    const result = await stopPublishedApp('app-1', 'idle', deps, {
      idleCutoff: new Date(NOW.getTime() - 900_000),
    });

    expect(result.outcome).toBe('stopped');
    expect(stopMachine).toHaveBeenCalled();
  });

  it('re-checks the LATER of the two stamps, so a fresh WAKE also saves the machine', async () => {
    // A wake that landed after the scan means the app is being served right now —
    // the wake precedes the request that caused it.
    const { deps } = makeDeps();
    seed(running({ lastHitAt: null, lastWakeAt: new Date(NOW.getTime() - 10_000) }));

    expect(await stopPublishedApp('app-1', 'idle', deps, { idleCutoff: new Date(NOW.getTime() - 900_000) })).toEqual({
      outcome: 'refused',
      reason: 'became_active',
    });
  });

  it('given NO cutoff (an operator stop, an insolvency park), should never consult recency', async () => {
    // Those are decisions about the app, not about how busy it is.
    const { deps, stopMachine } = makeDeps();
    seed(running({ lastHitAt: NOW }));

    const result = await stopPublishedApp('app-1', 'operator', deps);

    expect(result.outcome).toBe('stopped');
    expect(stopMachine).toHaveBeenCalled();
  });
});
