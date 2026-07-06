import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn((a, b) => ({ op: 'eq', a, b })) }));
vi.mock('@pagespace/db/schema/terminal-sessions', () => ({
  terminalSessions: { pageId: 'terminal_sessions.pageId', storageLastBilledAt: 'terminal_sessions.storageLastBilledAt' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', driveId: 'pages.driveId' },
  drives: { id: 'drives.id', ownerId: 'drives.ownerId' },
}));

const mockTrackUsage = vi.hoisted(() => vi.fn());
vi.mock('../../../monitoring/ai-monitoring', () => ({ AIMonitoring: { trackUsage: mockTrackUsage } }));

import { defaultReconcileTerminalStorageDeps } from '../terminal-storage-billing';
import { SANDBOX_RESOURCE_CAPS } from '../execution-policy';

beforeEach(() => {
  mockDb.select.mockReset();
  mockDb.update.mockReset();
  mockTrackUsage.mockReset();
});

describe('defaultReconcileTerminalStorageDeps.listMachines', () => {
  it('selects pageId + storageLastBilledAt from terminal_sessions', async () => {
    const rows = [{ pageId: 'p1', storageLastBilledAt: new Date('2026-06-01T00:00:00.000Z') }];
    mockDb.select.mockReturnValue({ from: () => rows });

    await expect(defaultReconcileTerminalStorageDeps.listMachines()).resolves.toEqual(rows);
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
      gbMonths: 2.5,
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
    expect(call.metadata).toMatchObject({ type: 'terminal_storage', pageId: 'page-1', gbMonths: 2.5 });
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

describe('defaultReconcileTerminalStorageDeps.storageGB', () => {
  it('uses the real provisioned storage cap (SANDBOX_RESOURCE_CAPS.storageGB), not a separate guess', () => {
    expect(defaultReconcileTerminalStorageDeps.storageGB).toBe(SANDBOX_RESOURCE_CAPS.storageGB);
  });
});
