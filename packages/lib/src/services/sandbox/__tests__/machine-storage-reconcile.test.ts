import { describe, it, expect, vi } from 'vitest';
import { assert } from './riteway';
import {
  reconcileMachineStorage,
  computeElapsedGbMonths,
  pickBillableGB,
  MS_PER_STORAGE_MONTH,
  STALE_MEASUREMENT_MS,
  type ReconcileMachineStorageDeps,
  type MachineStorageRow,
  type BranchStorageRow,
} from '../machine-storage-reconcile';

describe('computeElapsedGbMonths', () => {
  it('prices a full storage-month at the full measuredGB', () => {
    assert({
      given: 'a full storage-month of a 2GB measured footprint',
      should: 'accrue 2 GB-months',
      actual: computeElapsedGbMonths({ measuredGB: 2, elapsedMs: MS_PER_STORAGE_MONTH }),
      expected: 2,
    });
  });

  it('prorates a half-month to half the GB-months', () => {
    expect(computeElapsedGbMonths({ measuredGB: 4, elapsedMs: MS_PER_STORAGE_MONTH / 2 })).toBeCloseTo(2, 10);
  });

  it('returns 0 for zero or negative elapsed time', () => {
    assert({
      given: 'zero elapsed time',
      should: 'accrue nothing',
      actual: computeElapsedGbMonths({ measuredGB: 5, elapsedMs: 0 }),
      expected: 0,
    });
    expect(computeElapsedGbMonths({ measuredGB: 5, elapsedMs: -1000 })).toBe(0);
  });

  it('returns 0 for a non-positive measuredGB (never-measured / zero-usage floor)', () => {
    assert({
      given: 'a zero measured footprint',
      should: 'accrue nothing regardless of elapsed time',
      actual: computeElapsedGbMonths({ measuredGB: 0, elapsedMs: MS_PER_STORAGE_MONTH }),
      expected: 0,
    });
  });
});

describe('pickBillableGB', () => {
  const now = new Date('2026-07-01T00:00:00.000Z');

  it('bills a fresh measurement at its measured GB and reports not-stale', () => {
    assert({
      given: 'a measurement taken one minute ago',
      should: 'bill the measured GB and flag it fresh',
      actual: pickBillableGB({
        lastMeasuredGB: 0.2,
        lastMeasuredAt: new Date(now.getTime() - 60_000),
        awake: false,
        now,
      }),
      expected: { gb: 0.2, stale: false },
    });
  });

  it('reuses a stale measurement (older than the window) for billing but flags it stale', () => {
    assert({
      given: 'a paused machine whose last measurement is older than the stale window',
      should: 'still bill the last measured GB (never wake to re-measure) but flag stale',
      actual: pickBillableGB({
        lastMeasuredGB: 0.5,
        lastMeasuredAt: new Date(now.getTime() - STALE_MEASUREMENT_MS - 1),
        awake: false,
        now,
      }),
      expected: { gb: 0.5, stale: true },
    });
  });

  it('does not flag an awake machine stale even with an old timestamp (refresh is imminent)', () => {
    assert({
      given: 'an awake machine with an old measurement timestamp',
      should: 'bill the measured GB and NOT flag stale (opportunistic refresh will land)',
      actual: pickBillableGB({
        lastMeasuredGB: 0.5,
        lastMeasuredAt: new Date(now.getTime() - STALE_MEASUREMENT_MS - 1),
        awake: true,
        now,
      }),
      expected: { gb: 0.5, stale: false },
    });
  });

  it('falls back to a 0 floor (never the provisioned cap) when never measured', () => {
    assert({
      given: 'a machine that has never been measured',
      should: 'bill 0 (conservative floor), never the provisioned cap',
      actual: pickBillableGB({ lastMeasuredGB: null, lastMeasuredAt: null, awake: false, now }),
      expected: { gb: 0, stale: true },
    });
  });

  it('bills 0 for a machine measured at zero usage', () => {
    assert({
      given: 'a machine measured at exactly zero bytes',
      should: 'bill 0',
      actual: pickBillableGB({
        lastMeasuredGB: 0,
        lastMeasuredAt: new Date(now.getTime() - 60_000),
        awake: false,
        now,
      }),
      expected: { gb: 0, stale: false },
    });
  });
});

function makeDeps(over: Partial<ReconcileMachineStorageDeps> = {}): {
  deps: ReconcileMachineStorageDeps;
  chargeCalls: Array<{ payerId: string; pageId: string; costDollars: number; gbMonths: number }>;
  advanceCalls: Array<{ pageId: string; billedThrough: Date }>;
  branchAdvanceCalls: Array<{ machineBranchId: string; billedThrough: Date }>;
} {
  const chargeCalls: Array<{ payerId: string; pageId: string; costDollars: number; gbMonths: number }> = [];
  const advanceCalls: Array<{ pageId: string; billedThrough: Date }> = [];
  const branchAdvanceCalls: Array<{ machineBranchId: string; billedThrough: Date }> = [];
  const deps: ReconcileMachineStorageDeps = {
    listMachines: async () => [],
    listBranchSprites: async () => [],
    lookupPageOwnerId: async () => 'owner-1',
    chargeStorage: async (input) => {
      chargeCalls.push(input);
    },
    advanceWatermark: async (input) => {
      advanceCalls.push(input);
    },
    advanceBranchWatermark: async (input) => {
      branchAdvanceCalls.push(input);
    },
    now: () => new Date('2026-07-01T00:00:00.000Z'),
    ...over,
  };
  return { deps, chargeCalls, advanceCalls, branchAdvanceCalls };
}

/** A measured branch Sprite: 1GB written, measured just before `now`, owned by `machine-page-1`. */
function branch(over: Partial<BranchStorageRow> = {}): BranchStorageRow {
  return {
    machineBranchId: 'branch-1',
    machinePageId: 'machine-page-1',
    storageLastBilledAt: new Date('2026-06-01T00:00:00.000Z'),
    measuredBytes: 1_000_000_000, // 1 GB
    measuredAt: new Date('2026-06-30T23:00:00.000Z'),
    lastActiveAt: new Date('2026-06-30T23:59:00.000Z'),
    ...over,
  };
}

/** A measured machine: 1GB written, measured just before `now`, active (awake). */
function machine(over: Partial<MachineStorageRow> = {}): MachineStorageRow {
  return {
    pageId: 'page-1',
    storageLastBilledAt: new Date('2026-06-01T00:00:00.000Z'),
    measuredBytes: 1_000_000_000, // 1 GB
    measuredAt: new Date('2026-06-30T23:00:00.000Z'),
    lastActiveAt: new Date('2026-06-30T23:59:00.000Z'),
    ...over,
  };
}

describe('reconcileMachineStorage', () => {
  it('charges each machine for its MEASURED storage window and advances its watermark to now', async () => {
    const { deps, chargeCalls, advanceCalls } = makeDeps({
      listMachines: async () => [machine({ pageId: 'page-1' })],
    });

    const result = await reconcileMachineStorage(deps);

    expect(result).toMatchObject({ processed: 1, charged: 1, skipped: 0 });
    expect(chargeCalls).toHaveLength(1);
    expect(chargeCalls[0]).toMatchObject({ payerId: 'owner-1', pageId: 'page-1' });
    expect(chargeCalls[0].costDollars).toBeGreaterThan(0);
    // 1 GB measured over a 30-day window ≈ 1 GB-month — NOT the 5GB provisioned cap.
    expect(chargeCalls[0].gbMonths).toBeCloseTo(1, 5);
    expect(advanceCalls).toEqual([{ pageId: 'page-1', billedThrough: new Date('2026-07-01T00:00:00.000Z') }]);
  });

  it('NEVER bills from a provisioned allocation cap — a 200MB machine bills ~0.2 GB-months, not 5', async () => {
    const { deps, chargeCalls } = makeDeps({
      listMachines: async () => [machine({ pageId: 'small', measuredBytes: 200_000_000 })],
    });

    await reconcileMachineStorage(deps);

    assert({
      given: 'a machine that wrote 200MB over a ~30-day window',
      should: 'bill ~0.2 GB-months (measured), not the 5 GB provisioned cap',
      actual: Math.round(chargeCalls[0].gbMonths * 100) / 100,
      expected: 0.2,
    });
  });

  it('never wakes a sprite to measure — the cron makes zero sprite calls', async () => {
    // The deps seam exposes no sprite handle at all: a compile-time guarantee the
    // cron cannot exec against a machine. This asserts the runtime contract too —
    // reconcile touches only list/lookup/charge/advance, never a machine exec.
    const spriteExec = vi.fn();
    const { deps } = makeDeps({
      listMachines: async () => [machine({ pageId: 'page-1' }), machine({ pageId: 'page-2' })],
    });

    await reconcileMachineStorage(deps);

    expect(spriteExec).not.toHaveBeenCalled();
    expect(deps).not.toHaveProperty('exec');
    expect(deps).not.toHaveProperty('measure');
  });

  it('bills the payer resolved via lookupPageOwnerId for THIS machine page', async () => {
    const lookup = vi.fn(async (pageId: string) => `owner-of-${pageId}`);
    const { deps, chargeCalls } = makeDeps({
      listMachines: async () => [machine({ pageId: 'terminal-a' }), machine({ pageId: 'terminal-b' })],
      lookupPageOwnerId: lookup,
    });

    await reconcileMachineStorage(deps);

    expect(lookup).toHaveBeenCalledWith('terminal-a');
    expect(lookup).toHaveBeenCalledWith('terminal-b');
    expect(chargeCalls.map((c) => c.payerId).sort()).toEqual(['owner-of-terminal-a', 'owner-of-terminal-b']);
  });

  it('a SECOND run immediately after the first is a pure no-op — no charge, no re-advance', async () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    let watermark = new Date('2026-06-01T00:00:00.000Z');
    const chargeCalls: Array<unknown> = [];
    const advanceCalls: Array<unknown> = [];

    const deps: ReconcileMachineStorageDeps = {
      listMachines: async () => [machine({ pageId: 'page-1', storageLastBilledAt: watermark })],
      listBranchSprites: async () => [],
      lookupPageOwnerId: async () => 'owner-1',
      chargeStorage: async (input) => {
        chargeCalls.push(input);
      },
      advanceWatermark: async (input) => {
        advanceCalls.push(input);
        watermark = input.billedThrough;
      },
      advanceBranchWatermark: async () => {},
      now: () => now,
    };

    const first = await reconcileMachineStorage(deps);
    expect(first.charged).toBe(1);
    expect(chargeCalls).toHaveLength(1);
    expect(advanceCalls).toHaveLength(1);

    const second = await reconcileMachineStorage(deps);

    expect(second).toMatchObject({ processed: 1, charged: 0, skipped: 0, totalCostDollars: 0 });
    expect(chargeCalls).toHaveLength(1); // unchanged — no double charge
    expect(advanceCalls).toHaveLength(1); // unchanged — elapsed window is 0, nothing to advance
  });

  it('CUTOVER: a never-measured row bills $0 and advances its watermark so no window is retroactively billed', async () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    let watermark = new Date('2026-05-01T00:00:00.000Z'); // long pre-cutover accrual
    const chargeCalls: Array<unknown> = [];

    const deps: ReconcileMachineStorageDeps = {
      // Existing pre-cutover row: never measured (null bytes/at).
      listMachines: async () => [
        {
          pageId: 'legacy',
          storageLastBilledAt: watermark,
          measuredBytes: null,
          measuredAt: null,
          lastActiveAt: new Date('2026-05-01T00:00:00.000Z'),
        },
      ],
      listBranchSprites: async () => [],
      lookupPageOwnerId: async () => 'owner-1',
      chargeStorage: async (input) => {
        chargeCalls.push(input);
      },
      advanceWatermark: async (input) => {
        watermark = input.billedThrough;
      },
      advanceBranchWatermark: async () => {},
      now: () => now,
    };

    const result = await reconcileMachineStorage(deps);

    assert({
      given: 'a legacy never-measured row with a two-month pre-cutover window',
      should: 'charge nothing (no allocation bill)',
      actual: chargeCalls.length,
      expected: 0,
    });
    assert({
      given: 'the never-measured window',
      should: 'advance the watermark to now so a later measurement bills only forward',
      actual: watermark.toISOString(),
      expected: now.toISOString(),
    });
    expect(result).toMatchObject({ processed: 1, charged: 0 });
  });

  it('a MEASURED tiny footprint whose window cost rounds to $0 ADVANCES the watermark (bill $0, do not freeze)', async () => {
    const now = new Date('2026-07-01T01:00:00.000Z');
    const advanceCalls: Array<{ pageId: string; billedThrough: Date }> = [];
    const chargeCalls: Array<unknown> = [];

    const deps: ReconcileMachineStorageDeps = {
      listMachines: async () => [
        {
          pageId: 'tiny',
          // One hour elapsed at a ~1KB footprint prices below the 6-decimal
          // rounding floor → costDollars === 0.
          storageLastBilledAt: new Date('2026-07-01T00:00:00.000Z'),
          measuredBytes: 1_000, // MEASURED (not null), tiny
          measuredAt: new Date('2026-06-30T23:30:00.000Z'),
          lastActiveAt: new Date('2026-06-30T23:30:00.000Z'),
        },
      ],
      listBranchSprites: async () => [],
      lookupPageOwnerId: async () => 'owner-1',
      chargeStorage: async (input) => {
        chargeCalls.push(input);
      },
      advanceWatermark: async (input) => {
        advanceCalls.push(input);
      },
      advanceBranchWatermark: async () => {},
      now: () => now,
    };

    const result = await reconcileMachineStorage(deps);

    assert({
      given: 'a measured sub-cent footprint on a frequent cron',
      should: 'charge nothing but ADVANCE the watermark, so the window is settled and cannot be billed retroactively later',
      actual: { charged: chargeCalls.length, advanced: advanceCalls.length },
      expected: { charged: 0, advanced: 1 },
    });
    expect(result).toMatchObject({ processed: 1, charged: 0 });
  });

  it('NO retroactive over-bill: a tiny footprint that later grows bills only the post-growth window, not the whole frozen span', async () => {
    let watermark = new Date('2026-05-01T00:00:00.000Z'); // long-idle machine
    let measuredBytes = 1_000; // ~1KB → sub-cent → $0 this tick
    let measuredAt = new Date('2026-05-01T00:00:00.000Z');
    let nowIso = '2026-06-01T00:00:00.000Z';
    const chargeCalls: Array<{ gbMonths: number }> = [];

    const deps: ReconcileMachineStorageDeps = {
      listMachines: async () => [
        { pageId: 'grower', storageLastBilledAt: watermark, measuredBytes, measuredAt, lastActiveAt: measuredAt },
      ],
      listBranchSprites: async () => [],
      lookupPageOwnerId: async () => 'owner-1',
      chargeStorage: async (input) => {
        chargeCalls.push({ gbMonths: input.gbMonths });
      },
      advanceWatermark: async (input) => {
        watermark = input.billedThrough;
      },
      advanceBranchWatermark: async () => {},
      now: () => new Date(nowIso),
    };

    // Tick 1: tiny footprint, one month idle → $0, watermark advances to 2026-06-01.
    await reconcileMachineStorage(deps);
    expect(chargeCalls).toHaveLength(0);
    expect(watermark.toISOString()).toBe('2026-06-01T00:00:00.000Z');

    // The machine balloons to 100GB; next tick is exactly one month later.
    measuredBytes = 100_000_000_000;
    measuredAt = new Date('2026-06-20T00:00:00.000Z');
    nowIso = '2026-07-01T00:00:00.000Z';

    await reconcileMachineStorage(deps);

    // Billed window is 2026-06-01 → 2026-07-01 (one month at 100GB = ~100 GB-months),
    // NOT back to 2026-05-01 — the frozen-span retroactive over-bill is avoided.
    assert({
      given: 'a tiny footprint that grew to 100GB after its watermark advanced',
      should: 'bill ~100 GB-months (one month), not ~200 (two months back to the old watermark)',
      actual: Math.round(chargeCalls[0].gbMonths),
      expected: 100,
    });
  });

  it('CUTOVER continuity: after the watermark advances, the FIRST measured window bills only from the advanced mark (no over-bill)', async () => {
    let watermark = new Date('2026-05-01T00:00:00.000Z');
    let measuredBytes: number | null = null;
    let measuredAt: Date | null = null;
    let nowIso = '2026-06-01T00:00:00.000Z';
    const chargeCalls: Array<{ gbMonths: number }> = [];

    const deps: ReconcileMachineStorageDeps = {
      listMachines: async () => [
        {
          pageId: 'm',
          storageLastBilledAt: watermark,
          measuredBytes,
          measuredAt,
          lastActiveAt: new Date('2026-05-15T00:00:00.000Z'),
        },
      ],
      listBranchSprites: async () => [],
      lookupPageOwnerId: async () => 'owner-1',
      chargeStorage: async (input) => {
        chargeCalls.push({ gbMonths: input.gbMonths });
      },
      advanceWatermark: async (input) => {
        watermark = input.billedThrough;
      },
      advanceBranchWatermark: async () => {},
      now: () => new Date(nowIso),
    };

    // Tick 1 (never measured): advances watermark to 2026-06-01, charges $0.
    await reconcileMachineStorage(deps);
    expect(chargeCalls).toHaveLength(0);
    expect(watermark.toISOString()).toBe('2026-06-01T00:00:00.000Z');

    // A measurement lands (1 GB) between ticks; next tick is exactly one month later.
    measuredBytes = 1_000_000_000;
    measuredAt = new Date('2026-06-15T00:00:00.000Z');
    nowIso = '2026-07-01T00:00:00.000Z';

    await reconcileMachineStorage(deps);

    // Billed window is 2026-06-01 → 2026-07-01 (one month), NOT back to 2026-05-01.
    assert({
      given: 'the first measured tick after a cutover advance',
      should: 'bill ~1 GB-month (one month at 1GB), not the two-month pre-measurement span',
      actual: Math.round(chargeCalls[0].gbMonths * 100) / 100,
      expected: 1,
    });
  });

  it('skips (and does not advance the watermark for) a measured machine whose owner cannot be resolved', async () => {
    const { deps, chargeCalls, advanceCalls } = makeDeps({
      listMachines: async () => [machine({ pageId: 'orphaned' })],
      lookupPageOwnerId: async () => null,
    });

    const result = await reconcileMachineStorage(deps);

    expect(result).toMatchObject({ processed: 1, charged: 0, skipped: 1 });
    expect(chargeCalls).toEqual([]);
    expect(advanceCalls).toEqual([]);
  });

  it('isolates a per-machine failure: one row throwing does not abort the rest of the batch', async () => {
    const { deps, chargeCalls, advanceCalls } = makeDeps({
      listMachines: async () => [machine({ pageId: 'boom' }), machine({ pageId: 'fine' })],
      chargeStorage: async (input) => {
        if (input.pageId === 'boom') throw new Error('ledger write failed');
        chargeCalls.push(input);
      },
      advanceBranchWatermark: async () => {},
    });

    const result = await reconcileMachineStorage(deps);

    expect(result).toMatchObject({ processed: 2, charged: 1, skipped: 0, failed: 1 });
    expect(chargeCalls).toEqual([expect.objectContaining({ pageId: 'fine' })]);
    expect(advanceCalls).toEqual([expect.objectContaining({ pageId: 'fine' })]);
  });

  it('counts a measured-but-stale (paused, old measurement) machine in staleMeasurements while still billing it', async () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    const { deps, chargeCalls } = makeDeps({
      now: () => now,
      listMachines: async () => [
        machine({
          pageId: 'stale',
          storageLastBilledAt: new Date('2026-06-01T00:00:00.000Z'),
          measuredBytes: 1_000_000_000,
          measuredAt: new Date('2026-06-01T00:00:00.000Z'), // 30 days old → stale
          lastActiveAt: new Date('2026-06-01T00:00:00.000Z'), // not recently active → not awake
        }),
      ],
    });

    const result = await reconcileMachineStorage(deps);

    assert({
      given: 'a paused machine billed from a measurement older than the stale window',
      should: 'flag one stale measurement but still charge it',
      actual: { staleMeasurements: result.staleMeasurements, charged: result.charged },
      expected: { staleMeasurements: 1, charged: 1 },
    });
    expect(chargeCalls[0].costDollars).toBeGreaterThan(0);
  });

  it('does not count a never-measured machine as a stale measurement', async () => {
    const { deps } = makeDeps({
      listMachines: async () => [machine({ pageId: 'fresh-null', measuredBytes: null, measuredAt: null })],
    });

    const result = await reconcileMachineStorage(deps);

    assert({
      given: 'a never-measured machine',
      should: 'bill 0 and NOT be counted as a stale measurement',
      actual: { staleMeasurements: result.staleMeasurements, charged: result.charged },
      expected: { staleMeasurements: 0, charged: 0 },
    });
  });

  it('processes multiple measured machines independently, summing total cost', async () => {
    const { deps } = makeDeps({
      listMachines: async () => [
        machine({ pageId: 'page-1', storageLastBilledAt: new Date('2026-06-01T00:00:00.000Z') }),
        machine({ pageId: 'page-2', storageLastBilledAt: new Date('2026-06-16T00:00:00.000Z') }),
      ],
    });

    const result = await reconcileMachineStorage(deps);

    expect(result.processed).toBe(2);
    expect(result.charged).toBe(2);
    expect(result.totalCostDollars).toBeGreaterThan(0);
  });
});

describe('reconcileMachineStorage — branch-Sprite attribution (issue #2204 phase 3)', () => {
  it('bills a branch Sprite to its OWNING machine page, not to the branch row', async () => {
    const { deps, chargeCalls } = makeDeps({
      listBranchSprites: async () => [branch({ machineBranchId: 'branch-1', machinePageId: 'machine-page-1' })],
    });

    const result = await reconcileMachineStorage(deps);

    assert({
      given: 'a provisioned branch Sprite with a measured 1GB footprint',
      should: "charge its owning Machine page — the key the per-machine usage breakdown groups on",
      actual: { charged: result.charged, pageId: chargeCalls[0]?.pageId },
      expected: { charged: 1, pageId: 'machine-page-1' },
    });
    expect(chargeCalls[0].gbMonths).toBeCloseTo(1, 5);
    expect(chargeCalls[0].costDollars).toBeGreaterThan(0);
  });

  it('resolves the payer from the OWNING machine page (branch storage is owner-pays like every other branch cost)', async () => {
    const lookup = vi.fn(async (pageId: string) => `owner-of-${pageId}`);
    const { deps, chargeCalls } = makeDeps({
      listBranchSprites: async () => [branch({ machinePageId: 'machine-page-9' })],
      lookupPageOwnerId: lookup,
    });

    await reconcileMachineStorage(deps);

    expect(lookup).toHaveBeenCalledWith('machine-page-9');
    expect(chargeCalls[0]).toMatchObject({ payerId: 'owner-of-machine-page-9', pageId: 'machine-page-9' });
  });

  it('advances the BRANCH row watermark (never the machine session watermark) after charging', async () => {
    const { deps, advanceCalls, branchAdvanceCalls } = makeDeps({
      listBranchSprites: async () => [branch({ machineBranchId: 'branch-7' })],
    });

    await reconcileMachineStorage(deps);

    assert({
      given: 'a charged branch Sprite',
      should: "advance only its own machine_branches watermark",
      actual: { branchAdvanceCalls, machineAdvanceCalls: advanceCalls.length },
      expected: {
        branchAdvanceCalls: [{ machineBranchId: 'branch-7', billedThrough: new Date('2026-07-01T00:00:00.000Z') }],
        machineAdvanceCalls: 0,
      },
    });
  });

  it('meters a machine and its branches as independent footprints billed to the same page', async () => {
    const { deps, chargeCalls } = makeDeps({
      listMachines: async () => [machine({ pageId: 'machine-page-1' })],
      listBranchSprites: async () => [
        branch({ machineBranchId: 'branch-a', machinePageId: 'machine-page-1' }),
        branch({ machineBranchId: 'branch-b', machinePageId: 'machine-page-1', measuredBytes: 2_000_000_000 }),
      ],
    });

    const result = await reconcileMachineStorage(deps);

    expect(result.processed).toBe(3);
    expect(result.charged).toBe(3);
    // Each Sprite's own measured bytes, all attributed to the one machine page.
    expect(chargeCalls.map((c) => c.pageId)).toEqual(['machine-page-1', 'machine-page-1', 'machine-page-1']);
    expect(chargeCalls.map((c) => Math.round(c.gbMonths))).toEqual([1, 1, 2]);
  });

  it('NEVER wakes a hibernating branch Sprite to measure — it bills the last PERSISTED bytes only', async () => {
    // The deps seam exposes no sprite handle for branches either: a never-measured
    // branch bills the conservative 0 floor rather than being woken for a `du`.
    const { deps, chargeCalls, branchAdvanceCalls } = makeDeps({
      listBranchSprites: async () => [branch({ measuredBytes: null, measuredAt: null })],
    });

    const result = await reconcileMachineStorage(deps);

    assert({
      given: 'a hibernating branch Sprite that has never been measured',
      should: 'bill nothing (0 floor, no wake) while still advancing its watermark',
      actual: { charged: result.charged, charges: chargeCalls.length, advanced: branchAdvanceCalls.length },
      expected: { charged: 0, charges: 0, advanced: 1 },
    });
    expect(deps).not.toHaveProperty('attach');
    expect(deps).not.toHaveProperty('exec');
  });

  it('flags a stale branch measurement but still bills it (never wakes to refresh)', async () => {
    const { deps, chargeCalls } = makeDeps({
      listBranchSprites: async () => [
        branch({
          measuredAt: new Date(new Date('2026-07-01T00:00:00.000Z').getTime() - STALE_MEASUREMENT_MS - 1),
          lastActiveAt: new Date('2026-06-01T00:00:00.000Z'),
        }),
      ],
    });

    const result = await reconcileMachineStorage(deps);

    assert({
      given: 'a hibernating branch Sprite whose measurement is older than the stale window',
      should: 'still bill the last measured bytes and flag the staleness',
      actual: { staleMeasurements: result.staleMeasurements, charged: result.charged },
      expected: { staleMeasurements: 1, charged: 1 },
    });
    expect(chargeCalls[0].costDollars).toBeGreaterThan(0);
  });

  it('isolates a failing branch row from the rest of the batch', async () => {
    const { deps, chargeCalls } = makeDeps({
      listBranchSprites: async () => [branch({ machineBranchId: 'bad' }), branch({ machineBranchId: 'good' })],
      advanceBranchWatermark: async ({ machineBranchId }) => {
        if (machineBranchId === 'bad') throw new Error('watermark write failed');
      },
    });

    const result = await reconcileMachineStorage(deps);

    expect(result).toMatchObject({ processed: 2, charged: 1, failed: 1 });
    expect(chargeCalls).toHaveLength(2);
  });
});
