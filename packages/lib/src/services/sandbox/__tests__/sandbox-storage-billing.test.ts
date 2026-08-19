import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

const mockDb = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn() }));
const mockAdvisoryLockClient = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
const mockAdvisoryLockPool = vi.hoisted(() => ({ connect: vi.fn(async () => mockAdvisoryLockClient) }));
const mockGetAdvisoryLockPool = vi.hoisted(() => vi.fn(() => mockAdvisoryLockPool));
vi.mock('@pagespace/db/db', () => ({ db: mockDb, getAdvisoryLockPool: mockGetAdvisoryLockPool }));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...parts) => ({ op: 'and', parts })),
  isNull: vi.fn((a) => ({ op: 'isNull', a })),
  isNotNull: vi.fn((a) => ({ op: 'isNotNull', a })),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', driveId: 'pages.driveId' },
  drives: { id: 'drives.id', ownerId: 'drives.ownerId' },
}));
vi.mock('@pagespace/db/schema/agent-workspaces', () => ({
  agentWorkspaces: {
    id: 'agent_workspaces.id',
    driveId: 'agent_workspaces.driveId',
    ownerId: 'agent_workspaces.ownerId',
    sandboxId: 'agent_workspaces.sandboxId',
    spriteTornDownAt: 'agent_workspaces.spriteTornDownAt',
    storageLastBilledAt: 'agent_workspaces.storageLastBilledAt',
    storageMeasuredBytes: 'agent_workspaces.storageMeasuredBytes',
    storageMeasuredAt: 'agent_workspaces.storageMeasuredAt',
    lastActiveAt: 'agent_workspaces.lastActiveAt',
  },
}));

vi.mock('@pagespace/db/schema/drive-envs', () => ({
  driveEnvs: {
    id: 'drive_envs.id',
    driveId: 'drive_envs.driveId',
    sandboxId: 'drive_envs.sandboxId',
    spriteTornDownAt: 'drive_envs.spriteTornDownAt',
    storageLastBilledAt: 'drive_envs.storageLastBilledAt',
    storageMeasuredBytes: 'drive_envs.storageMeasuredBytes',
    storageMeasuredAt: 'drive_envs.storageMeasuredAt',
    lastActiveAt: 'drive_envs.lastActiveAt',
  },
}));

const mockTrackUsage = vi.hoisted(() => vi.fn());
vi.mock('../../../monitoring/ai-monitoring', () => ({ AIMonitoring: { trackUsage: mockTrackUsage } }));

import {
  defaultReconcileSandboxStorageDeps,
  reconcileSandboxStorageSerialized,
} from '../sandbox-storage-billing';
import { MACHINE_MARKUP_BPS } from '../../../billing/credit-pricing';
import type { ReconcileSandboxStorageDeps } from '../sandbox-storage-reconcile';

beforeEach(() => {
  mockDb.select.mockReset();
  mockDb.update.mockReset();
  mockTrackUsage.mockReset();
  mockAdvisoryLockPool.connect.mockClear();
  mockAdvisoryLockClient.query.mockReset();
  mockAdvisoryLockClient.release.mockReset();
  mockGetAdvisoryLockPool.mockClear();
});

describe('defaultReconcileSandboxStorageDeps.listAgentSessionSprites', () => {
  it("selects each session's own measurement/watermark, driveId and ownerId directly — no join, no de-fan needed", async () => {
    const rows = [
      {
        workspaceId: 'session-1',
        driveId: 'agent-page-1',
        ownerId: 'owner-1',
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
      return {
        from: () => ({
          where: (w: unknown) => {
            whereArg = w;
            return rows;
          },
        }),
      };
    });

    await expect(defaultReconcileSandboxStorageDeps.listAgentSessionSprites()).resolves.toEqual(rows);

    expect(Object.keys(selectedShape ?? {}).sort()).toEqual(
      ['driveId', 'lastActiveAt', 'measuredAt', 'measuredBytes', 'ownerId', 'workspaceId', 'storageLastBilledAt'].sort(),
    );
    expect(whereArg).toEqual({
      op: 'and',
      parts: [
        { op: 'isNotNull', a: 'agent_workspaces.sandboxId' },
        { op: 'isNull', a: 'agent_workspaces.spriteTornDownAt' },
      ],
    });
  });

  it('falls back a null lastActiveAt to the epoch — the honest "not awake" reading', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({
        where: async () => [
          {
            workspaceId: 'session-1',
            driveId: null,
            ownerId: 'owner-1',
            storageLastBilledAt: new Date('2026-06-01T00:00:00.000Z'),
            measuredBytes: null,
            measuredAt: null,
            lastActiveAt: null,
          },
        ],
      }),
    });

    const rows = await defaultReconcileSandboxStorageDeps.listAgentSessionSprites();

    expect(rows[0]).toMatchObject({ driveId: null, lastActiveAt: new Date(0) });
  });
});

describe('defaultReconcileSandboxStorageDeps.lookupDriveOwnerId', () => {
  it('is the shared sandbox-payer.ts lookup (a direct drives read — no page join exists any more)', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [{ ownerId: 'owner-1' }],
        }),
      }),
    });
    await expect(defaultReconcileSandboxStorageDeps.lookupDriveOwnerId('drive-1')).resolves.toBe('owner-1');
  });
});

describe('defaultReconcileSandboxStorageDeps.chargeStorage', () => {
  it("bills source:'terminal' with no holdId (background reconcile charge)", async () => {
    mockTrackUsage.mockResolvedValue(undefined);

    await defaultReconcileSandboxStorageDeps.chargeStorage({
      payerId: 'owner-1',
      driveId: 'drive-1',
      subjectKind: 'session',
      subjectId: 'session-1',
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
      // First-class attribution — top-level columns, not just metadata forensics.
      driveId: 'drive-1',
      // `AIUsageData.sessionId` is the shared analytics column many sources
      // write; the subject's own id is mapped onto it at the boundary.
      sessionId: 'session-1',
      // The billed unit, named in the meter line — sessions keep the label
      // they have always written.
      model: 'terminal-machine-storage',
    });
    expect(call.holdId).toBeUndefined();
    expect(call.metadata).toMatchObject({ type: 'terminal_storage', gbMonths: 0.2 });
  });

  it("passes MACHINE_MARKUP_BPS as markupBpsOverride", async () => {
    mockTrackUsage.mockResolvedValue(undefined);

    await defaultReconcileSandboxStorageDeps.chargeStorage({
      payerId: 'owner-1',
      driveId: 'drive-1',
      subjectKind: 'session',
      subjectId: 'session-1',
      costDollars: 0.05,
      gbMonths: 0.2,
    });

    expect(mockTrackUsage.mock.calls[0][0].markupBpsOverride).toBe(MACHINE_MARKUP_BPS);
  });

  it('sends NO top-level pageId — a session is drive-scoped, not page-anchored', async () => {
    mockTrackUsage.mockResolvedValue(undefined);

    await defaultReconcileSandboxStorageDeps.chargeStorage({
      payerId: 'owner-1',
      driveId: 'drive-1',
      subjectKind: 'session',
      subjectId: 'session-1',
      costDollars: 0.05,
      gbMonths: 0.2,
    });

    // The drive and session ride as first-class top-level columns instead.
    expect(mockTrackUsage.mock.calls[0][0].pageId).toBeUndefined();
    expect(mockTrackUsage.mock.calls[0][0]).toMatchObject({ driveId: 'drive-1', sessionId: 'session-1' });
  });

  it('given a global-assistant session (no drive), forwards driveId as undefined rather than null', async () => {
    mockTrackUsage.mockResolvedValue(undefined);

    await defaultReconcileSandboxStorageDeps.chargeStorage({
      payerId: 'owner-1',
      driveId: undefined,
      subjectKind: 'session',
      subjectId: 'session-1',
      costDollars: 0.05,
      gbMonths: 0.2,
    });

    expect(mockTrackUsage.mock.calls[0][0].driveId).toBeUndefined();
    expect(mockTrackUsage.mock.calls[0][0].sessionId).toBe('session-1');
  });
});

describe('defaultReconcileSandboxStorageDeps.advanceAgentSessionWatermark', () => {
  it("updates the SESSION row's own storageLastBilledAt, keyed by the session id", async () => {
    const setCalls: unknown[] = [];
    const whereCalls: unknown[] = [];
    mockDb.update.mockReturnValue({
      set: (values: unknown) => {
        setCalls.push(values);
        return { where: async (w: unknown) => { whereCalls.push(w); } };
      },
    });

    await defaultReconcileSandboxStorageDeps.advanceAgentSessionWatermark({
      workspaceId: 'session-3',
      billedThrough: new Date('2026-07-01T00:00:00.000Z'),
    });

    expect(setCalls).toEqual([{ storageLastBilledAt: new Date('2026-07-01T00:00:00.000Z') }]);
    expect(whereCalls).toEqual([{ op: 'eq', a: 'agent_workspaces.id', b: 'session-3' }]);
  });
});

describe('defaultReconcileSandboxStorageDeps.listDriveEnvSprites', () => {
  it("selects each env's own measurement/watermark and its drive — the same live-Sprite predicate the session source uses", async () => {
    const rows = [
      {
        envId: 'env-1',
        driveId: 'drive-1',
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
      return {
        from: () => ({
          where: (w: unknown) => {
            whereArg = w;
            return rows;
          },
        }),
      };
    });

    await expect(defaultReconcileSandboxStorageDeps.listDriveEnvSprites()).resolves.toEqual(rows);

    // No `ownerId`: `drive_envs` has none, and `createdBy` is audit-only —
    // selecting it would be the first step toward billing the creator.
    expect(Object.keys(selectedShape ?? {}).sort()).toEqual(
      ['driveId', 'envId', 'lastActiveAt', 'measuredAt', 'measuredBytes', 'storageLastBilledAt'].sort(),
    );
    assert({
      given: "the env row source's predicate",
      should: 'match the partial live-Sprite index — provisioned and not torn down',
      actual: whereArg,
      expected: {
        op: 'and',
        parts: [
          { op: 'isNotNull', a: 'drive_envs.sandboxId' },
          { op: 'isNull', a: 'drive_envs.spriteTornDownAt' },
        ],
      },
    });
  });

  it('falls back a null lastActiveAt to the epoch — an env is persistent, so idleness is a health reading only', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({
        where: async () => [
          {
            envId: 'env-1',
            driveId: 'drive-1',
            storageLastBilledAt: new Date('2026-06-01T00:00:00.000Z'),
            measuredBytes: null,
            measuredAt: null,
            lastActiveAt: null,
          },
        ],
      }),
    });

    const rows = await defaultReconcileSandboxStorageDeps.listDriveEnvSprites();

    expect(rows[0]).toMatchObject({ driveId: 'drive-1', lastActiveAt: new Date(0) });
  });
});

describe('defaultReconcileSandboxStorageDeps.chargeStorage — env subjects', () => {
  it('bills an env on the SAME meter, labelled as an environment and attributed to its drive', async () => {
    mockTrackUsage.mockResolvedValue(undefined);

    await defaultReconcileSandboxStorageDeps.chargeStorage({
      payerId: 'drive-owner-1',
      driveId: 'drive-1',
      subjectKind: 'env',
      subjectId: 'env-1',
      costDollars: 0.05,
      gbMonths: 0.2,
    });

    const call = mockTrackUsage.mock.calls[0][0];
    assert({
      given: 'an environment storage charge',
      should: "ride the same provider/source/markup as a session's, under its own billed-unit label",
      actual: {
        provider: call.provider,
        source: call.source,
        model: call.model,
        driveId: call.driveId,
        sessionId: call.sessionId,
        userId: call.userId,
        markupBpsOverride: call.markupBpsOverride,
        type: call.metadata.type,
      },
      expected: {
        provider: 'sprites',
        source: 'terminal',
        model: 'drive-env-storage',
        driveId: 'drive-1',
        sessionId: 'env-1',
        userId: 'drive-owner-1',
        markupBpsOverride: MACHINE_MARKUP_BPS,
        type: 'env_storage',
      },
    });
  });
});

describe('defaultReconcileSandboxStorageDeps.advanceDriveEnvWatermark', () => {
  it("updates the ENV row's own storageLastBilledAt, keyed by the env id", async () => {
    const setCalls: unknown[] = [];
    const whereCalls: unknown[] = [];
    mockDb.update.mockReturnValue({
      set: (values: unknown) => {
        setCalls.push(values);
        return { where: async (w: unknown) => { whereCalls.push(w); } };
      },
    });

    await defaultReconcileSandboxStorageDeps.advanceDriveEnvWatermark({
      envId: 'env-3',
      billedThrough: new Date('2026-07-01T00:00:00.000Z'),
    });

    expect(setCalls).toEqual([{ storageLastBilledAt: new Date('2026-07-01T00:00:00.000Z') }]);
    expect(whereCalls).toEqual([{ op: 'eq', a: 'drive_envs.id', b: 'env-3' }]);
  });
});

describe('reconcileSandboxStorageSerialized', () => {
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

  function makeDeps(overrides: Partial<ReconcileSandboxStorageDeps> = {}): ReconcileSandboxStorageDeps {
    return {
      listAgentSessionSprites: vi.fn(async () => []),
      listDriveEnvSprites: vi.fn(async () => []),
      lookupDriveOwnerId: vi.fn(async () => null),
      chargeStorage: vi.fn(async () => {}),
      advanceAgentSessionWatermark: vi.fn(async () => {}),
      advanceDriveEnvWatermark: vi.fn(async () => {}),
      now: () => new Date('2026-07-13T00:00:00.000Z'),
      ...overrides,
    };
  }

  it('given the lock is already held elsewhere, should no-op WITHOUT calling reconcileSandboxStorage', async () => {
    const { pool } = makeFakeLockPool();
    // Pre-acquire the lock so this run's try-lock sees it busy.
    await pool.connect().then((c) => c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', ['x']));
    const deps = makeDeps();

    const result = await reconcileSandboxStorageSerialized(deps, pool);

    expect(result).toEqual({ outcome: 'lock_busy' });
    expect(deps.listAgentSessionSprites).not.toHaveBeenCalled();
  });

  it('given two concurrent reconcile calls, should let only one proceed while the other no-ops, and release the lock after', async () => {
    const { pool, isLocked } = makeFakeLockPool();
    const deps = makeDeps();

    const [first, second] = await Promise.all([
      reconcileSandboxStorageSerialized(deps, pool),
      reconcileSandboxStorageSerialized(deps, pool),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    assert({
      given: 'two concurrent calls racing the same advisory lock',
      should: 'resolve exactly one reconciled and one lock_busy',
      actual: outcomes,
      expected: ['lock_busy', 'reconciled'],
    });
    expect(deps.listAgentSessionSprites).toHaveBeenCalledTimes(1);

    // Released after the winning run: lock is free and a later run can acquire it.
    expect(isLocked()).toBe(false);
    const third = await reconcileSandboxStorageSerialized(deps, pool);
    expect(third.outcome).toBe('reconciled');
    expect(deps.listAgentSessionSprites).toHaveBeenCalledTimes(2);
  });

  it('given no explicit pool override, should acquire the lock from the dedicated advisoryLockPool (NOT the shared db pool)', async () => {
    // Regression test for the pool-exhaustion deadlock a reviewer flagged: at
    // DB_POOL_MAX=1, pinning the lock connection from the SAME pool Drizzle's
    // `db` draws from would starve `listAgentSessionSprites`'s own query forever,
    // since nothing can free the one connection while the lock holds it. The
    // lock must come from `advisoryLockPool` — a pool dedicated to holding
    // locks, never application queries — so the two can never contend.
    mockAdvisoryLockClient.query.mockResolvedValueOnce({ rows: [{ acquired: true }] }); // try-lock
    mockAdvisoryLockClient.query.mockResolvedValueOnce({ rows: [] }); // unlock
    const deps = makeDeps();

    const result = await reconcileSandboxStorageSerialized(deps);

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

    const result = await reconcileSandboxStorageSerialized(deps, pool);

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

    await expect(reconcileSandboxStorageSerialized(deps, pool)).rejects.toThrow('connection reset');

    // Never resolved acquired/not-acquired — the connection's protocol state
    // is indeterminate, so it must be destroyed, not pooled alive.
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(deps.listAgentSessionSprites).not.toHaveBeenCalled();
  });
});
