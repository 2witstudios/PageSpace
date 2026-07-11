import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

const mockDb = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn((a, b) => ({ op: 'eq', a, b })) }));
vi.mock('@pagespace/db/schema/terminal-sessions', () => ({
  terminalSessions: {
    pageId: 'terminal_sessions.pageId',
    storageLastBilledAt: 'terminal_sessions.storageLastBilledAt',
    storageMeasuredBytes: 'terminal_sessions.storageMeasuredBytes',
    storageMeasuredAt: 'terminal_sessions.storageMeasuredAt',
    lastActiveAt: 'terminal_sessions.lastActiveAt',
  },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', driveId: 'pages.driveId' },
  drives: { id: 'drives.id', ownerId: 'drives.ownerId' },
}));

const mockTrackUsage = vi.hoisted(() => vi.fn());
vi.mock('../../../monitoring/ai-monitoring', () => ({ AIMonitoring: { trackUsage: mockTrackUsage } }));

import {
  defaultReconcileTerminalStorageDeps,
  persistStorageMeasurement,
  measureMachineStorageOpportunistically,
  __resetStorageMeasurementCachesForTests,
} from '../terminal-storage-billing';
import { TERMINAL_MARKUP_BPS } from '../../../billing/credit-pricing';

beforeEach(() => {
  mockDb.select.mockReset();
  mockDb.update.mockReset();
  mockTrackUsage.mockReset();
  // Clear the module-level in-process caches so cases don't bleed state.
  __resetStorageMeasurementCachesForTests();
});

describe('defaultReconcileTerminalStorageDeps.listMachines', () => {
  it('selects measured bytes/at + watermark + lastActiveAt from terminal_sessions (never a provisioned cap)', async () => {
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

    await expect(defaultReconcileTerminalStorageDeps.listMachines()).resolves.toEqual(rows);
    // The measured columns must be part of the projection — bills measured bytes.
    expect(Object.keys(selectedShape ?? {}).sort()).toEqual(
      ['lastActiveAt', 'measuredAt', 'measuredBytes', 'pageId', 'storageLastBilledAt'].sort(),
    );
  });
});

describe('defaultReconcileTerminalStorageDeps has NO provisioned-cap dependency', () => {
  it('does not expose a storageGB field (measured bytes replace the allocation cap)', () => {
    assert({
      given: 'the storage reconcile deps',
      should: 'carry no storageGB allocation input',
      actual: 'storageGB' in defaultReconcileTerminalStorageDeps,
      expected: false,
    });
  });
});

describe('defaultReconcileTerminalStorageDeps.lookupPageOwnerId', () => {
  it('is the shared terminal-payer.ts lookup (pages -> drives join)', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            limit: async () => [{ ownerId: 'owner-1' }],
          }),
        }),
      }),
    });
    await expect(defaultReconcileTerminalStorageDeps.lookupPageOwnerId('page-1')).resolves.toBe('owner-1');
  });
});

describe('defaultReconcileTerminalStorageDeps.chargeStorage', () => {
  it("bills source:'terminal' with no holdId (background reconcile charge)", async () => {
    mockTrackUsage.mockResolvedValue(undefined);

    await defaultReconcileTerminalStorageDeps.chargeStorage({
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

  it("passes TERMINAL_MARKUP_BPS as markupBpsOverride", async () => {
    mockTrackUsage.mockResolvedValue(undefined);

    await defaultReconcileTerminalStorageDeps.chargeStorage({
      payerId: 'owner-1',
      pageId: 'page-1',
      costDollars: 0.05,
      gbMonths: 0.2,
    });

    expect(mockTrackUsage.mock.calls[0][0].markupBpsOverride).toBe(TERMINAL_MARKUP_BPS);
  });

  it('forwards pageId as a TOP-LEVEL field for per-machine attribution', async () => {
    mockTrackUsage.mockResolvedValue(undefined);

    await defaultReconcileTerminalStorageDeps.chargeStorage({
      payerId: 'owner-1',
      pageId: 'page-1',
      costDollars: 0.05,
      gbMonths: 0.2,
    });

    expect(mockTrackUsage.mock.calls[0][0].pageId).toBe('page-1');
  });
});

describe('defaultReconcileTerminalStorageDeps.advanceWatermark', () => {
  it('updates storageLastBilledAt for the given pageId', async () => {
    const setCalls: unknown[] = [];
    mockDb.update.mockReturnValue({
      set: (values: unknown) => {
        setCalls.push(values);
        return { where: async () => {} };
      },
    });

    const billedThrough = new Date('2026-07-01T00:00:00.000Z');
    await defaultReconcileTerminalStorageDeps.advanceWatermark({ pageId: 'page-1', billedThrough });

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
    await persistStorageMeasurement({ pageId: 'page-1', measuredBytes: 204800 * 1024, measuredAt });

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

  it('resolveHandle path: does NOT attach when the page has no terminal_sessions row (no wasted network attach)', async () => {
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

  it('skips (no exec, no write) when the page has no terminal_sessions row', async () => {
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
