import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

const mockDb = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn() }));
const mockAdvisoryLockClient = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
const mockAdvisoryLockPool = vi.hoisted(() => ({ connect: vi.fn(async () => mockAdvisoryLockClient) }));
const mockGetAdvisoryLockPool = vi.hoisted(() => vi.fn(() => mockAdvisoryLockPool));
vi.mock('@pagespace/db/db', () => ({ db: mockDb, getAdvisoryLockPool: mockGetAdvisoryLockPool }));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  isNull: vi.fn((a) => ({ op: 'isNull', a })),
}));
vi.mock('@pagespace/db/schema/machine-sessions', () => ({
  machineSessions: {
    pageId: 'machine_sessions.pageId',
    storageLastBilledAt: 'machine_sessions.storageLastBilledAt',
    storageMeasuredBytes: 'machine_sessions.storageMeasuredBytes',
    storageMeasuredAt: 'machine_sessions.storageMeasuredAt',
    lastActiveAt: 'machine_sessions.lastActiveAt',
  },
}));
vi.mock('@pagespace/db/schema/machine-branches', () => ({
  machineBranches: {
    id: 'machine_branches.id',
    machineId: 'machine_branches.machineId',
    storageLastBilledAt: 'machine_branches.storageLastBilledAt',
    storageMeasuredBytes: 'machine_branches.storageMeasuredBytes',
    storageMeasuredAt: 'machine_branches.storageMeasuredAt',
    spriteTornDownAt: 'machine_branches.spriteTornDownAt',
  },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', driveId: 'pages.driveId' },
  drives: { id: 'drives.id', ownerId: 'drives.ownerId' },
}));

const mockTrackUsage = vi.hoisted(() => vi.fn());
vi.mock('../../../monitoring/ai-monitoring', () => ({ AIMonitoring: { trackUsage: mockTrackUsage } }));

import {
  defaultReconcileMachineStorageDeps,
  persistStorageMeasurement,
  measureMachineStorageOpportunistically,
  measureBranchStorageOpportunistically,
  reconcileMachineStorageSerialized,
  __resetStorageMeasurementCachesForTests,
} from '../machine-storage-billing';
import { MACHINE_MARKUP_BPS } from '../../../billing/credit-pricing';
import type { ReconcileMachineStorageDeps } from '../machine-storage-reconcile';

beforeEach(() => {
  mockDb.select.mockReset();
  mockDb.update.mockReset();
  mockTrackUsage.mockReset();
  mockAdvisoryLockPool.connect.mockClear();
  mockAdvisoryLockClient.query.mockReset();
  mockAdvisoryLockClient.release.mockReset();
  mockGetAdvisoryLockPool.mockClear();
  // Clear the module-level in-process caches so cases don't bleed state.
  __resetStorageMeasurementCachesForTests();
});

describe('defaultReconcileMachineStorageDeps.listMachines', () => {
  it('selects measured bytes/at + watermark + lastActiveAt from machine_sessions (never a provisioned cap)', async () => {
    const rows = [
      {
        pageId: 'p1',
        storageLastBilledAt: new Date('2026-06-01T00:00:00.000Z'),
        measuredBytes: 200_000_000,
        measuredAt: new Date('2026-06-30T00:00:00.000Z'),
        lastActiveAt: new Date('2026-06-30T12:00:00.000Z'),
      },
    ];
    let selectedShape: Record<string, unknown> | undefined;
    mockDb.select.mockImplementation((shape: Record<string, unknown>) => {
      selectedShape = shape;
      return { from: () => rows };
    });

    await expect(defaultReconcileMachineStorageDeps.listMachines()).resolves.toEqual(rows);
    // The measured columns must be part of the projection — bills measured bytes.
    expect(Object.keys(selectedShape ?? {}).sort()).toEqual(
      ['lastActiveAt', 'measuredAt', 'measuredBytes', 'pageId', 'storageLastBilledAt'].sort(),
    );
  });
});

describe('defaultReconcileMachineStorageDeps has NO provisioned-cap dependency', () => {
  it('does not expose a storageGB field (measured bytes replace the allocation cap)', () => {
    assert({
      given: 'the storage reconcile deps',
      should: 'carry no storageGB allocation input',
      actual: 'storageGB' in defaultReconcileMachineStorageDeps,
      expected: false,
    });
  });
});

describe('defaultReconcileMachineStorageDeps.listBranchSprites', () => {
  it('returns each branch filesystem ONCE even when the machine-session join fans out', async () => {
    // machine_sessions.pageId carries no uniqueness guarantee — only sessionKey
    // is unique — so two session rows sharing the owning page would duplicate
    // every branch row through the left join, and reconcile would charge one
    // branch disk once per duplicate. The freshest activity must win the
    // staleness flag.
    const dup = (lastActiveAt: Date | null) => ({
      machineBranchId: 'br-1',
      machinePageId: 'm-1',
      storageLastBilledAt: new Date('2026-06-01T00:00:00.000Z'),
      measuredBytes: 1_000,
      measuredAt: new Date('2026-06-30T00:00:00.000Z'),
      lastActiveAt,
    });
    mockDb.select.mockReturnValue({
      from: () => ({
        leftJoin: () => ({
          where: async () => [
            dup(new Date('2026-06-29T00:00:00.000Z')),
            dup(new Date('2026-06-30T12:00:00.000Z')),
            dup(null),
          ],
        }),
      }),
    });

    const rows = await defaultReconcileMachineStorageDeps.listBranchSprites();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      machineBranchId: 'br-1',
      lastActiveAt: new Date('2026-06-30T12:00:00.000Z'),
    });
  });
});

describe('defaultReconcileMachineStorageDeps.lookupPageOwnerId', () => {
  it('is the shared machine-payer.ts lookup (pages -> drives join)', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            limit: async () => [{ ownerId: 'owner-1' }],
          }),
        }),
      }),
    });
    await expect(defaultReconcileMachineStorageDeps.lookupPageOwnerId('page-1')).resolves.toBe('owner-1');
  });
});

describe('defaultReconcileMachineStorageDeps.chargeStorage', () => {
  it("bills source:'terminal' with no holdId (background reconcile charge)", async () => {
    mockTrackUsage.mockResolvedValue(undefined);

    await defaultReconcileMachineStorageDeps.chargeStorage({
      payerId: 'owner-1',
      pageId: 'page-1',
      costDollars: 0.05,
      gbMonths: 0.2,
    });

    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    const call = mockTrackUsage.mock.calls[0][0];
    expect(call).toMatchObject({
      userId: 'owner-1',
      source: 'terminal',
      providerCostDollars: 0.05,
      success: true,
      costSource: 'list_price',
    });
    expect(call.holdId).toBeUndefined();
    expect(call.metadata).toMatchObject({ type: 'terminal_storage', pageId: 'page-1', gbMonths: 0.2 });
  });

  it("passes MACHINE_MARKUP_BPS as markupBpsOverride", async () => {
    mockTrackUsage.mockResolvedValue(undefined);

    await defaultReconcileMachineStorageDeps.chargeStorage({
      payerId: 'owner-1',
      pageId: 'page-1',
      costDollars: 0.05,
      gbMonths: 0.2,
    });

    expect(mockTrackUsage.mock.calls[0][0].markupBpsOverride).toBe(MACHINE_MARKUP_BPS);
  });

  it('forwards pageId as a TOP-LEVEL field for per-machine attribution', async () => {
    mockTrackUsage.mockResolvedValue(undefined);

    await defaultReconcileMachineStorageDeps.chargeStorage({
      payerId: 'owner-1',
      pageId: 'page-1',
      costDollars: 0.05,
      gbMonths: 0.2,
    });

    expect(mockTrackUsage.mock.calls[0][0].pageId).toBe('page-1');
  });
});

describe('defaultReconcileMachineStorageDeps.advanceWatermark', () => {
  it('updates storageLastBilledAt for the given pageId', async () => {
    const setCalls: unknown[] = [];
    mockDb.update.mockReturnValue({
      set: (values: unknown) => {
        setCalls.push(values);
        return { where: async () => {} };
      },
    });

    const billedThrough = new Date('2026-07-01T00:00:00.000Z');
    await defaultReconcileMachineStorageDeps.advanceWatermark({ pageId: 'page-1', billedThrough });

    expect(setCalls).toEqual([{ storageLastBilledAt: billedThrough }]);
  });
});

describe('persistStorageMeasurement', () => {
  it('writes measured bytes + measuredAt onto the machine row by pageId', async () => {
    const setCalls: unknown[] = [];
    const whereCalls: unknown[] = [];
    mockDb.update.mockReturnValue({
      set: (values: unknown) => {
        setCalls.push(values);
        return {
          where: async (w: unknown) => {
            whereCalls.push(w);
          },
        };
      },
    });

    const measuredAt = new Date('2026-07-01T00:00:00.000Z');
    await persistStorageMeasurement({
      subject: { kind: 'machine', pageId: 'page-1' },
      measuredBytes: 204800 * 1024,
      measuredAt,
    });

    expect(setCalls).toEqual([{ storageMeasuredBytes: 204800 * 1024, storageMeasuredAt: measuredAt }]);
    expect(whereCalls).toHaveLength(1);
  });
});

describe('measureMachineStorageOpportunistically', () => {
  // Each test uses a UNIQUE pageId: the helper keeps a module-scoped in-process
  // throttle cache keyed by pageId that persists across tests in this run.
  const DU_OK = '209715200\t/workspace';

  it('measures via the live handle (du) and persists when the throttle window has elapsed', async () => {
    // Row exists, never measured (null measuredAt) → not throttled.
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [{ storageMeasuredAt: null }] }) }),
    });
    const setCalls: unknown[] = [];
    mockDb.update.mockReturnValue({
      set: (v: unknown) => {
        setCalls.push(v);
        return { where: async () => {} };
      },
    });
    const exec = vi.fn(async (_args: { cmd: string; args?: string[] }) => ({ exitCode: 0, stdout: DU_OK, stderr: '' }));

    await measureMachineStorageOpportunistically({ handle: { exec }, pageId: 'measure-elapsed' });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).toMatchObject({ cmd: 'du' });
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toMatchObject({ storageMeasuredBytes: 209_715_200 });
  });

  it('in-process throttle: a second call for the same page within the window does NO DB read and NO exec', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [{ storageMeasuredAt: null }] }) }),
    });
    mockDb.update.mockReturnValue({ set: () => ({ where: async () => {} }) });
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: DU_OK, stderr: '' }));

    // First call warms the cache + measures.
    await measureMachineStorageOpportunistically({ handle: { exec }, pageId: 'throttle-page' });
    const selectsAfterFirst = mockDb.select.mock.calls.length;
    const execsAfterFirst = exec.mock.calls.length;

    // Second immediate call must short-circuit before any DB/exec work.
    await measureMachineStorageOpportunistically({ handle: { exec }, pageId: 'throttle-page' });

    assert({
      given: 'a second measurement attempt for the same page within the throttle window',
      should: 'issue no additional DB SELECT and no additional sprite exec',
      actual: { selects: mockDb.select.mock.calls.length - selectsAfterFirst, execs: exec.mock.calls.length - execsAfterFirst },
      expected: { selects: 0, execs: 0 },
    });
  });

  it('resolveHandle path: lazily attaches and measures when due + row exists', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [{ storageMeasuredAt: null }] }) }),
    });
    mockDb.update.mockReturnValue({ set: () => ({ where: async () => {} }) });
    const exec = vi.fn(async (_args: { cmd: string }) => ({ exitCode: 0, stdout: DU_OK, stderr: '' }));
    const resolveHandle = vi.fn(async () => ({ exec }));

    await measureMachineStorageOpportunistically({ pageId: 'lazy-due', resolveHandle });

    expect(resolveHandle).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('resolveHandle path: does NOT attach when the page has no machine_sessions row (no wasted network attach)', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    });
    const resolveHandle = vi.fn(async () => ({ exec: vi.fn() }));

    await measureMachineStorageOpportunistically({ pageId: 'lazy-no-row', resolveHandle });

    assert({
      given: 'a lazy resolveHandle caller and a page with no billing row',
      should: 'never invoke resolveHandle (attach is gated behind the row check)',
      actual: resolveHandle.mock.calls.length,
      expected: 0,
    });
  });

  it('resolveHandle path: does NOT attach when the PERSISTED measurement is recent (cold in-process cache, another instance measured)', async () => {
    // Cold in-process cache (fresh pageId) but the row was measured 1 minute ago
    // → the persisted throttle must gate the attach.
    const recent = new Date(Date.now() - 60_000);
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [{ storageMeasuredAt: recent }] }) }),
    });
    const resolveHandle = vi.fn(async () => ({ exec: vi.fn() }));

    await measureMachineStorageOpportunistically({ pageId: 'lazy-persisted-recent', resolveHandle });

    assert({
      given: 'a cold in-process cache but a persisted measurement within the window',
      should: 'skip the network attach (persisted throttle gates it)',
      actual: resolveHandle.mock.calls.length,
      expected: 0,
    });
  });

  it('resolveHandle path: does NOT attach on a throttled second call within the window', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [{ storageMeasuredAt: null }] }) }),
    });
    mockDb.update.mockReturnValue({ set: () => ({ where: async () => {} }) });
    const resolveHandle = vi.fn(async () => ({ exec: vi.fn(async () => ({ exitCode: 0, stdout: DU_OK, stderr: '' })) }));

    await measureMachineStorageOpportunistically({ pageId: 'lazy-throttle', resolveHandle });
    await measureMachineStorageOpportunistically({ pageId: 'lazy-throttle', resolveHandle });

    assert({
      given: 'a second lazy measurement attempt within the throttle window',
      should: 'resolve the handle only once (no wasted attach on the throttled call)',
      actual: resolveHandle.mock.calls.length,
      expected: 1,
    });
  });

  it('transient failure does NOT lock out re-measurement: a null-handle attempt is retried on the next call', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [{ storageMeasuredAt: null }] }) }),
    });
    mockDb.update.mockReturnValue({ set: () => ({ where: async () => {} }) });
    // First resolveHandle transiently fails (null); second succeeds.
    let call = 0;
    const exec = vi.fn(async (_args: { cmd: string }) => ({ exitCode: 0, stdout: DU_OK, stderr: '' }));
    const resolveHandle = vi.fn(async () => {
      call += 1;
      return call === 1 ? null : { exec };
    });

    await measureMachineStorageOpportunistically({ pageId: 'transient', resolveHandle });
    await measureMachineStorageOpportunistically({ pageId: 'transient', resolveHandle });

    assert({
      given: 'a first attempt whose handle resolution transiently failed (not cached)',
      should: 'retry on the next call within the window (resolveHandle invoked twice, measured on the second)',
      actual: { resolves: resolveHandle.mock.calls.length, execs: exec.mock.calls.length },
      expected: { resolves: 2, execs: 1 },
    });
  });

  it('concurrent-dedup: a burst of parallel calls for the same page collapses to ONE measurement', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [{ storageMeasuredAt: null }] }) }),
    });
    mockDb.update.mockReturnValue({ set: () => ({ where: async () => {} }) });
    const exec = vi.fn(async (_args: { cmd: string }) => ({ exitCode: 0, stdout: DU_OK, stderr: '' }));

    // Fire five in parallel in the same tick.
    await Promise.all(
      Array.from({ length: 5 }, () => measureMachineStorageOpportunistically({ pageId: 'burst', handle: { exec } })),
    );

    assert({
      given: 'five parallel measurement calls for one page in the same tick',
      should: 'run exactly one du (the in-flight guard collapses the rest)',
      actual: exec.mock.calls.length,
      expected: 1,
    });
  });

  it('skips (no exec, no write) when the page has no machine_sessions row', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    });
    const exec = vi.fn();

    await measureMachineStorageOpportunistically({ handle: { exec }, pageId: 'missing-row' });

    assert({
      given: 'a page with no billing row',
      should: 'not exec any measurement against the sprite',
      actual: exec.mock.calls.length,
      expected: 0,
    });
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('is non-fatal: a thrown DB/exec error is swallowed', async () => {
    mockDb.select.mockImplementation(() => {
      throw new Error('db down');
    });
    const exec = vi.fn();

    await expect(
      measureMachineStorageOpportunistically({ handle: { exec }, pageId: 'throws-page' }),
    ).resolves.toBeUndefined();
  });
});

describe('reconcileMachineStorageSerialized', () => {
  // Simulates real Postgres session-advisory-lock semantics with a single
  // shared in-memory flag: exactly one connection can hold it at a time, and
  // pg_advisory_unlock releases it for the next contender.
  function makeFakeLockPool() {
    let locked = false;
    const clients: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }[] = [];
    const pool = {
      connect: vi.fn(async () => {
        const client = {
          query: vi.fn(async (text: string, _params?: unknown[]) => {
            if (text.includes('pg_try_advisory_lock')) {
              if (locked) return { rows: [{ acquired: false }] };
              locked = true;
              return { rows: [{ acquired: true }] };
            }
            if (text.includes('pg_advisory_unlock')) {
              locked = false;
              return { rows: [] };
            }
            return { rows: [] };
          }),
          release: vi.fn(),
        };
        clients.push(client);
        return client;
      }),
    };
    return { pool, clients, isLocked: () => locked };
  }

  function makeDeps(overrides: Partial<ReconcileMachineStorageDeps> = {}): ReconcileMachineStorageDeps {
    return {
      listMachines: vi.fn(async () => []),
      listBranchSprites: vi.fn(async () => []),
      lookupPageOwnerId: vi.fn(async () => null),
      chargeStorage: vi.fn(async () => {}),
      advanceWatermark: vi.fn(async () => {}),
      advanceBranchWatermark: vi.fn(async () => {}),
      now: () => new Date('2026-07-13T00:00:00.000Z'),
      ...overrides,
    };
  }

  it('given the lock is already held elsewhere, should no-op WITHOUT calling reconcileMachineStorage', async () => {
    const { pool } = makeFakeLockPool();
    // Pre-acquire the lock so this run's try-lock sees it busy.
    await pool.connect().then((c) => c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', ['x']));
    const deps = makeDeps();

    const result = await reconcileMachineStorageSerialized(deps, pool);

    expect(result).toEqual({ outcome: 'lock_busy' });
    expect(deps.listMachines).not.toHaveBeenCalled();
  });

  it('given two concurrent reconcile calls, should let only one proceed while the other no-ops, and release the lock after', async () => {
    const { pool, isLocked } = makeFakeLockPool();
    const deps = makeDeps();

    const [first, second] = await Promise.all([
      reconcileMachineStorageSerialized(deps, pool),
      reconcileMachineStorageSerialized(deps, pool),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    assert({
      given: 'two concurrent calls racing the same advisory lock',
      should: 'resolve exactly one reconciled and one lock_busy',
      actual: outcomes,
      expected: ['lock_busy', 'reconciled'],
    });
    expect(deps.listMachines).toHaveBeenCalledTimes(1);

    // Released after the winning run: lock is free and a later run can acquire it.
    expect(isLocked()).toBe(false);
    const third = await reconcileMachineStorageSerialized(deps, pool);
    expect(third.outcome).toBe('reconciled');
    expect(deps.listMachines).toHaveBeenCalledTimes(2);
  });

  it('given no explicit pool override, should acquire the lock from the dedicated advisoryLockPool (NOT the shared db pool)', async () => {
    // Regression test for the pool-exhaustion deadlock a reviewer flagged: at
    // DB_POOL_MAX=1, pinning the lock connection from the SAME pool Drizzle's
    // `db` draws from would starve `listMachines`'s own query forever, since
    // nothing can free the one connection while the lock holds it. The lock
    // must come from `advisoryLockPool` — a pool dedicated to holding locks,
    // never application queries — so the two can never contend.
    mockAdvisoryLockClient.query.mockResolvedValueOnce({ rows: [{ acquired: true }] }); // try-lock
    mockAdvisoryLockClient.query.mockResolvedValueOnce({ rows: [] }); // unlock
    const deps = makeDeps();

    const result = await reconcileMachineStorageSerialized(deps);

    expect(result.outcome).toBe('reconciled');
    expect(mockGetAdvisoryLockPool).toHaveBeenCalledTimes(1);
    expect(mockAdvisoryLockPool.connect).toHaveBeenCalledTimes(1);
    expect(mockAdvisoryLockClient.release).toHaveBeenCalledTimes(1);
  });

  it('given the unlock query itself fails, should destroy the connection instead of releasing it alive', async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // try-lock
        .mockRejectedValueOnce(new Error('unlock failed')), // unlock
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    const deps = makeDeps();

    const result = await reconcileMachineStorageSerialized(deps, pool);

    expect(result.outcome).toBe('reconciled');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('given the try-lock query itself throws (not just acquired:false), should destroy the connection and rethrow', async () => {
    const client = {
      query: vi.fn().mockRejectedValueOnce(new Error('connection reset')),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    const deps = makeDeps();

    await expect(reconcileMachineStorageSerialized(deps, pool)).rejects.toThrow('connection reset');

    // Never resolved acquired/not-acquired — the connection's protocol state
    // is indeterminate, so it must be destroyed, not pooled alive.
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(deps.listMachines).not.toHaveBeenCalled();
  });
});

describe('defaultReconcileMachineStorageDeps.listBranchSprites (issue #2204 phase 3)', () => {
  it('selects each branch row\'s OWN measurement/watermark plus its owning machine page as the attribution key', async () => {
    const rows = [
      {
        machineBranchId: 'branch-1',
        machinePageId: 'machine-page-1',
        storageLastBilledAt: new Date('2026-06-01T00:00:00.000Z'),
        measuredBytes: 1_000_000_000,
        measuredAt: new Date('2026-06-30T00:00:00.000Z'),
        lastActiveAt: new Date('2026-06-30T12:00:00.000Z'),
      },
    ];
    let selectedShape: Record<string, unknown> | undefined;
    let whereArg: unknown;
    mockDb.select.mockImplementation((shape: Record<string, unknown>) => {
      selectedShape = shape;
      return { from: () => ({ leftJoin: () => ({ where: (w: unknown) => { whereArg = w; return rows; } }) }) };
    });

    await expect(defaultReconcileMachineStorageDeps.listBranchSprites()).resolves.toEqual(rows);

    expect(Object.keys(selectedShape ?? {}).sort()).toEqual(
      ['lastActiveAt', 'machineBranchId', 'machinePageId', 'measuredAt', 'measuredBytes', 'storageLastBilledAt'].sort(),
    );
    // Torn-down branch Sprites have no filesystem left to meter.
    expect(whereArg).toEqual({ op: 'isNull', a: 'machine_branches.spriteTornDownAt' });
  });

  it('falls back to the epoch when the owning machine has no session row (not awake, never a fabricated activity)', async () => {
    mockDb.select.mockImplementation(() => ({
      from: () => ({
        leftJoin: () => ({
          where: () => [
            {
              machineBranchId: 'branch-2',
              machinePageId: 'machine-page-2',
              storageLastBilledAt: new Date('2026-06-01T00:00:00.000Z'),
              measuredBytes: null,
              measuredAt: null,
              lastActiveAt: null,
            },
          ],
        }),
      }),
    }));

    const [row] = await defaultReconcileMachineStorageDeps.listBranchSprites();

    assert({
      given: 'a branch whose owning machine has never had a session row',
      should: 'report the epoch as lastActiveAt (treated as not awake)',
      actual: row.lastActiveAt.getTime(),
      expected: 0,
    });
  });
});

describe('defaultReconcileMachineStorageDeps.advanceBranchWatermark', () => {
  it("updates the BRANCH row's own storageLastBilledAt, keyed by branch id", async () => {
    const setCalls: unknown[] = [];
    const whereCalls: unknown[] = [];
    mockDb.update.mockReturnValue({
      set: (values: unknown) => {
        setCalls.push(values);
        return {
          where: async (w: unknown) => {
            whereCalls.push(w);
          },
        };
      },
    });

    const billedThrough = new Date('2026-07-01T00:00:00.000Z');
    await defaultReconcileMachineStorageDeps.advanceBranchWatermark({ machineBranchId: 'branch-1', billedThrough });

    expect(setCalls).toEqual([{ storageLastBilledAt: billedThrough }]);
    expect(whereCalls).toEqual([{ op: 'eq', a: 'machine_branches.id', b: 'branch-1' }]);
  });
});

describe('persistStorageMeasurement — branch subject', () => {
  it("writes a branch Sprite's bytes onto ITS OWN machine_branches row, never the machine's", async () => {
    const setCalls: unknown[] = [];
    const whereCalls: unknown[] = [];
    mockDb.update.mockReturnValue({
      set: (values: unknown) => {
        setCalls.push(values);
        return {
          where: async (w: unknown) => {
            whereCalls.push(w);
          },
        };
      },
    });

    const measuredAt = new Date('2026-07-01T00:00:00.000Z');
    await persistStorageMeasurement({
      subject: { kind: 'branch', machineBranchId: 'branch-1', machinePageId: 'machine-page-1' },
      measuredBytes: 500_000_000,
      measuredAt,
    });

    assert({
      given: 'a measurement of a branch-terminal Sprite',
      should: 'update the branch row by id (the machine row would clobber the machine\'s own footprint)',
      actual: { set: setCalls, where: whereCalls },
      expected: {
        set: [{ storageMeasuredBytes: 500_000_000, storageMeasuredAt: measuredAt }],
        where: [{ op: 'eq', a: 'machine_branches.id', b: 'branch-1' }],
      },
    });
  });
});

describe('measureBranchStorageOpportunistically', () => {
  const DU_OK = '209715200\t/workspace';

  it('measures a live branch Sprite and persists onto its own row', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [{ storageMeasuredAt: null, spriteTornDownAt: null }] }) }),
    });
    const setCalls: unknown[] = [];
    mockDb.update.mockReturnValue({
      set: (v: unknown) => {
        setCalls.push(v);
        return { where: async () => {} };
      },
    });
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: DU_OK, stderr: '' }));

    await measureBranchStorageOpportunistically({
      machineBranchId: 'branch-measure-1',
      machinePageId: 'machine-page-1',
      handle: { exec },
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(setCalls).toEqual([expect.objectContaining({ storageMeasuredBytes: 209_715_200 })]);
  });

  it('never measures a TORN-DOWN branch Sprite (its filesystem is gone)', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [{ storageMeasuredAt: null, spriteTornDownAt: new Date('2026-06-01T00:00:00.000Z') }],
        }),
      }),
    });
    const exec = vi.fn();

    await measureBranchStorageOpportunistically({
      machineBranchId: 'branch-torn-down',
      machinePageId: 'machine-page-1',
      handle: { exec },
    });

    assert({
      given: 'a branch row whose Sprite is already torn down',
      should: 'run no du at all',
      actual: exec.mock.calls.length,
      expected: 0,
    });
  });

  it('keys its throttle per SUBJECT: a branch measurement never suppresses its owning machine\'s', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({
        where: () => ({ limit: async () => [{ storageMeasuredAt: null, spriteTornDownAt: null }] }),
      }),
    });
    mockDb.update.mockReturnValue({ set: () => ({ where: async () => {} }) });
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: DU_OK, stderr: '' }));

    await measureBranchStorageOpportunistically({
      machineBranchId: 'shared-id',
      machinePageId: 'shared-id',
      handle: { exec },
    });
    await measureMachineStorageOpportunistically({ pageId: 'shared-id', handle: { exec } });

    assert({
      given: 'a branch row id and a machine page id that happen to be the same string',
      should: 'measure both filesystems (namespaced subject keys cannot collide)',
      actual: exec.mock.calls.length,
      expected: 2,
    });
  });
});
