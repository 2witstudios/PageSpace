import { describe, it, expect, vi } from 'vitest';
import {
  reconcileTerminalStorage,
  computeElapsedGbMonths,
  MS_PER_STORAGE_MONTH,
  type ReconcileTerminalStorageDeps,
  type TerminalStorageMachineRow,
} from '../terminal-storage-reconcile';

describe('computeElapsedGbMonths', () => {
  it('prices a full storage-month at the full storageGB', () => {
    expect(computeElapsedGbMonths({ storageGB: 5, elapsedMs: MS_PER_STORAGE_MONTH })).toBeCloseTo(5, 10);
  });

  it('prorates a half-month to half the GB-months', () => {
    expect(computeElapsedGbMonths({ storageGB: 5, elapsedMs: MS_PER_STORAGE_MONTH / 2 })).toBeCloseTo(2.5, 10);
  });

  it('returns 0 for zero or negative elapsed time', () => {
    expect(computeElapsedGbMonths({ storageGB: 5, elapsedMs: 0 })).toBe(0);
    expect(computeElapsedGbMonths({ storageGB: 5, elapsedMs: -1000 })).toBe(0);
  });

  it('returns 0 for a non-positive storageGB', () => {
    expect(computeElapsedGbMonths({ storageGB: 0, elapsedMs: MS_PER_STORAGE_MONTH })).toBe(0);
  });
});

function makeDeps(over: Partial<ReconcileTerminalStorageDeps> = {}): {
  deps: ReconcileTerminalStorageDeps;
  chargeCalls: Array<{ payerId: string; pageId: string; costDollars: number; gbMonths: number }>;
  advanceCalls: Array<{ pageId: string; billedThrough: Date }>;
} {
  const chargeCalls: Array<{ payerId: string; pageId: string; costDollars: number; gbMonths: number }> = [];
  const advanceCalls: Array<{ pageId: string; billedThrough: Date }> = [];
  const deps: ReconcileTerminalStorageDeps = {
    listMachines: async () => [],
    lookupPageOwnerId: async () => 'owner-1',
    chargeStorage: async (input) => {
      chargeCalls.push(input);
    },
    advanceWatermark: async (input) => {
      advanceCalls.push(input);
    },
    now: () => new Date('2026-07-01T00:00:00.000Z'),
    storageGB: 5,
    ...over,
  };
  return { deps, chargeCalls, advanceCalls };
}

function machine(over: Partial<TerminalStorageMachineRow> = {}): TerminalStorageMachineRow {
  return {
    pageId: 'page-1',
    storageLastBilledAt: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  };
}

describe('reconcileTerminalStorage', () => {
  it('charges each machine for its accrued storage window and advances its watermark to now', async () => {
    const { deps, chargeCalls, advanceCalls } = makeDeps({
      listMachines: async () => [machine({ pageId: 'page-1' })],
    });

    const result = await reconcileTerminalStorage(deps);

    expect(result).toMatchObject({ processed: 1, charged: 1, skipped: 0 });
    expect(chargeCalls).toHaveLength(1);
    expect(chargeCalls[0]).toMatchObject({ payerId: 'owner-1', pageId: 'page-1' });
    expect(chargeCalls[0].costDollars).toBeGreaterThan(0);
    expect(advanceCalls).toEqual([{ pageId: 'page-1', billedThrough: new Date('2026-07-01T00:00:00.000Z') }]);
  });

  it('bills the payer resolved via lookupPageOwnerId for THIS machine page, not a caller-supplied identity', async () => {
    const lookup = vi.fn(async (pageId: string) => `owner-of-${pageId}`);
    const { deps, chargeCalls } = makeDeps({
      listMachines: async () => [machine({ pageId: 'terminal-a' }), machine({ pageId: 'terminal-b' })],
      lookupPageOwnerId: lookup,
    });

    await reconcileTerminalStorage(deps);

    expect(lookup).toHaveBeenCalledWith('terminal-a');
    expect(lookup).toHaveBeenCalledWith('terminal-b');
    expect(chargeCalls.map((c) => c.payerId).sort()).toEqual(['owner-of-terminal-a', 'owner-of-terminal-b']);
  });

  it('a SECOND run immediately after the first is a pure no-op — no charge, no re-advance', async () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    let watermark = new Date('2026-06-01T00:00:00.000Z');
    const chargeCalls: Array<unknown> = [];

    const deps: ReconcileTerminalStorageDeps = {
      listMachines: async () => [{ pageId: 'page-1', storageLastBilledAt: watermark }],
      lookupPageOwnerId: async () => 'owner-1',
      chargeStorage: async (input) => {
        chargeCalls.push(input);
      },
      advanceWatermark: async (input) => {
        watermark = input.billedThrough;
      },
      now: () => now,
      storageGB: 5,
    };

    const first = await reconcileTerminalStorage(deps);
    expect(first.charged).toBe(1);
    expect(chargeCalls).toHaveLength(1);

    const second = await reconcileTerminalStorage(deps);

    expect(second).toMatchObject({ processed: 1, charged: 0, skipped: 0, totalCostDollars: 0 });
    expect(chargeCalls).toHaveLength(1); // unchanged — no double charge
  });

  it('skips (and does not advance the watermark for) a machine whose page/drive owner cannot be resolved', async () => {
    const { deps, chargeCalls, advanceCalls } = makeDeps({
      listMachines: async () => [machine({ pageId: 'orphaned' })],
      lookupPageOwnerId: async () => null,
    });

    const result = await reconcileTerminalStorage(deps);

    expect(result).toMatchObject({ processed: 1, charged: 0, skipped: 1 });
    expect(chargeCalls).toEqual([]);
    expect(advanceCalls).toEqual([]);
  });

  it('isolates a per-machine failure: one row throwing does not abort the rest of the batch', async () => {
    const { deps, chargeCalls, advanceCalls } = makeDeps({
      listMachines: async () => [
        machine({ pageId: 'boom' }),
        machine({ pageId: 'fine' }),
      ],
      chargeStorage: async (input) => {
        if (input.pageId === 'boom') throw new Error('ledger write failed');
        chargeCalls.push(input);
      },
    });

    const result = await reconcileTerminalStorage(deps);

    expect(result).toMatchObject({ processed: 2, charged: 1, skipped: 0, failed: 1 });
    expect(chargeCalls).toEqual([expect.objectContaining({ pageId: 'fine' })]);
    expect(advanceCalls).toEqual([expect.objectContaining({ pageId: 'fine' })]);
  });

  it('processes multiple machines independently, summing total cost', async () => {
    const { deps } = makeDeps({
      listMachines: async () => [
        machine({ pageId: 'page-1', storageLastBilledAt: new Date('2026-06-01T00:00:00.000Z') }),
        machine({ pageId: 'page-2', storageLastBilledAt: new Date('2026-06-16T00:00:00.000Z') }),
      ],
    });

    const result = await reconcileTerminalStorage(deps);

    expect(result.processed).toBe(2);
    expect(result.charged).toBe(2);
    expect(result.totalCostDollars).toBeGreaterThan(0);
  });
});
