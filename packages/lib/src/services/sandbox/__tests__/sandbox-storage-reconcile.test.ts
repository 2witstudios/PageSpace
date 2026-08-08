import { describe, it, expect, vi } from 'vitest';
import { assert } from './riteway';
import {
  reconcileSandboxStorage,
  computeElapsedGbMonths,
  pickBillableGB,
  bytesToGB,
  MS_PER_STORAGE_MONTH,
  STALE_MEASUREMENT_MS,
  type ReconcileSandboxStorageDeps,
  type AgentSessionStorageRow,
} from '../sandbox-storage-reconcile';

describe('bytesToGB', () => {
  it('converts bytes to DECIMAL GB (÷1e9, matching the provider allocation + rate)', () => {
    assert({ given: '1e9 bytes', should: 'be 1 GB', actual: bytesToGB(1_000_000_000), expected: 1 });
    expect(bytesToGB(200_000_000)).toBeCloseTo(0.2, 10);
  });

  it('floors invalid / non-positive input at 0', () => {
    expect(bytesToGB(0)).toBe(0);
    expect(bytesToGB(-5)).toBe(0);
    expect(bytesToGB(Number.NaN)).toBe(0);
  });
});

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
      given: 'a paused sandbox whose last measurement is older than the stale window',
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

  it('does not flag an awake sandbox stale even with an old timestamp (refresh is imminent)', () => {
    assert({
      given: 'an awake sandbox with an old measurement timestamp',
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
      given: 'a sandbox that has never been measured',
      should: 'bill 0 (conservative floor), never the provisioned cap',
      actual: pickBillableGB({ lastMeasuredGB: null, lastMeasuredAt: null, awake: false, now }),
      expected: { gb: 0, stale: true },
    });
  });

  it('bills 0 for a sandbox measured at zero usage', () => {
    assert({
      given: 'a sandbox measured at exactly zero bytes',
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

function makeDeps(over: Partial<ReconcileSandboxStorageDeps> = {}): {
  deps: ReconcileSandboxStorageDeps;
  chargeCalls: Array<{ payerId: string; driveId?: string; workspaceId: string; costDollars: number; gbMonths: number }>;
  agentSessionAdvanceCalls: Array<{ workspaceId: string; billedThrough: Date }>;
} {
  const chargeCalls: Array<{ payerId: string; driveId?: string; workspaceId: string; costDollars: number; gbMonths: number }> = [];
  const agentSessionAdvanceCalls: Array<{ workspaceId: string; billedThrough: Date }> = [];
  const deps: ReconcileSandboxStorageDeps = {
    listAgentSessionSprites: async () => [],
    lookupDriveOwnerId: async () => 'owner-1',
    chargeStorage: async (input) => {
      chargeCalls.push(input);
    },
    advanceAgentSessionWatermark: async (input) => {
      agentSessionAdvanceCalls.push(input);
    },
    now: () => new Date('2026-07-01T00:00:00.000Z'),
    ...over,
  };
  return { deps, chargeCalls, agentSessionAdvanceCalls };
}

/** A measured agent-session Sprite: 1GB written, measured just before `now`, in `drive-1`. */
function agentSession(over: Partial<AgentSessionStorageRow> = {}): AgentSessionStorageRow {
  return {
    workspaceId: 'session-1',
    driveId: 'drive-1',
    ownerId: 'session-owner-1',
    storageLastBilledAt: new Date('2026-06-01T00:00:00.000Z'),
    measuredBytes: 1_000_000_000, // 1 GB
    measuredAt: new Date('2026-06-30T23:00:00.000Z'),
    lastActiveAt: new Date('2026-06-30T23:59:00.000Z'),
    ...over,
  };
}

describe('reconcileSandboxStorage', () => {
  it('bills an agent-session Sprite to its drive for its MEASURED storage window and advances its watermark', async () => {
    const { deps, chargeCalls, agentSessionAdvanceCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ workspaceId: 'session-1', driveId: 'drive-1' })],
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'an agent-session Sprite with a backing drive and a measured 1GB footprint',
      should: 'charge its drive — the key the usage breakdown groups on',
      actual: { charged: result.charged, driveId: chargeCalls[0]?.driveId },
      expected: { charged: 1, driveId: 'drive-1' },
    });
    expect(chargeCalls[0].gbMonths).toBeCloseTo(1, 5);
    expect(chargeCalls[0].costDollars).toBeGreaterThan(0);
    expect(agentSessionAdvanceCalls).toEqual([{ workspaceId: 'session-1', billedThrough: new Date('2026-07-01T00:00:00.000Z') }]);
  });

  it('resolves the payer via lookupDriveOwnerId when driveId is set', async () => {
    const lookup = vi.fn(async (driveId: string) => `owner-of-${driveId}`);
    const { deps, chargeCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ driveId: 'drive-9', ownerId: 'session-owner-9' })],
      lookupDriveOwnerId: lookup,
    });

    await reconcileSandboxStorage(deps);

    expect(lookup).toHaveBeenCalledWith('drive-9');
    expect(chargeCalls[0]).toMatchObject({ payerId: 'owner-of-drive-9', driveId: 'drive-9' });
  });

  it('bills a global-assistant session (null driveId) straight to its ownerId, with no drive lookup and no driveId on the charge', async () => {
    const lookup = vi.fn(async () => 'should-not-be-called');
    const { deps, chargeCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ driveId: null, ownerId: 'global-owner-1' })],
      lookupDriveOwnerId: lookup,
    });

    const result = await reconcileSandboxStorage(deps);

    expect(lookup).not.toHaveBeenCalled();
    assert({
      given: 'a global-assistant agent-session Sprite (no backing drive)',
      should: 'charge the session ownerId directly, with driveId omitted from the charge',
      actual: { charged: result.charged, payerId: chargeCalls[0]?.payerId, driveId: chargeCalls[0]?.driveId },
      expected: { charged: 1, payerId: 'global-owner-1', driveId: undefined },
    });
  });

  it('bills the never-measured 0 floor for a just-provisioned session and still advances its own watermark', async () => {
    const { deps, chargeCalls, agentSessionAdvanceCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ measuredBytes: null, measuredAt: null })],
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'an agent-session whose Sprite has never been measured',
      should: 'charge nothing (the 0 floor, never a provisioned cap) but still advance its watermark',
      actual: { charged: result.charged, charges: chargeCalls.length, advanced: agentSessionAdvanceCalls.length },
      expected: { charged: 0, charges: 0, advanced: 1 },
    });
  });

  it('skips (and does not advance the watermark for) a page-backed session whose page owner cannot be resolved', async () => {
    const { deps, chargeCalls, agentSessionAdvanceCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ driveId: 'orphaned-page' })],
      lookupDriveOwnerId: async () => null,
    });

    const result = await reconcileSandboxStorage(deps);

    expect(result).toMatchObject({ processed: 1, charged: 0, skipped: 1 });
    expect(chargeCalls).toEqual([]);
    expect(agentSessionAdvanceCalls).toEqual([]);
  });

  it('given chargeStorage succeeds but the FOLLOWING watermark advance throws, counts the money as charged (never under-reported) and flags the row distinguishably', async () => {
    const { deps, chargeCalls, agentSessionAdvanceCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ workspaceId: 'boom' }), agentSession({ workspaceId: 'fine' })],
      advanceAgentSessionWatermark: async (input) => {
        if (input.workspaceId === 'boom') throw new Error('watermark write failed');
        agentSessionAdvanceCalls.push(input);
      },
    });

    const result = await reconcileSandboxStorage(deps);

    // Both rows' money actually moved (chargeStorage succeeded for both) — so
    // BOTH count toward `charged`/`totalCostDollars`, regardless of the
    // watermark outcome. 'boom's failed advance is its own distinct signal
    // (`chargedButUnadvanced`), not folded into `failed` (which would imply
    // nothing was billed).
    expect(result).toMatchObject({ processed: 2, charged: 2, failed: 0, chargedButUnadvanced: 1 });
    expect(result.totalCostDollars).toBeGreaterThan(0);
    expect(chargeCalls).toHaveLength(2);
    // Only 'fine' successfully advanced — 'boom' will be billed again next run.
    expect(agentSessionAdvanceCalls.map((c) => c.workspaceId)).toEqual(['fine']);
  });

  it('given chargeStorage ITSELF throws, bills nothing for that row (no double-count) and never attempts its watermark advance', async () => {
    const { deps, chargeCalls, agentSessionAdvanceCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ workspaceId: 'boom' }), agentSession({ workspaceId: 'fine' })],
      chargeStorage: async (input) => {
        if (input.workspaceId === 'boom') throw new Error('credit ledger unreachable');
        chargeCalls.push(input);
      },
    });

    const result = await reconcileSandboxStorage(deps);

    expect(result).toMatchObject({ processed: 2, charged: 1, failed: 1, chargedButUnadvanced: 0 });
    expect(chargeCalls).toHaveLength(1);
    expect(chargeCalls[0].workspaceId).toBe('fine');
    expect(agentSessionAdvanceCalls.map((c) => c.workspaceId)).toEqual(['fine']);
  });

  it('given a stale measurement on an idle session, still bills the last measured value and flags it stale', async () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    const { deps } = makeDeps({
      listAgentSessionSprites: async () => [
        agentSession({
          measuredAt: new Date(now.getTime() - STALE_MEASUREMENT_MS - 1),
          lastActiveAt: new Date(now.getTime() - 60 * 60 * 1000),
        }),
      ],
      now: () => now,
    });

    const result = await reconcileSandboxStorage(deps);

    expect(result).toMatchObject({ charged: 1, staleMeasurements: 1 });
  });
});
