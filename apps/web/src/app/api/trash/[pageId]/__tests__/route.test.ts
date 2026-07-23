/**
 * Permanent page delete — the machine-ref repair (issue #2156).
 *
 * This route is one of the paths that makes a MachineRef permanently dangling:
 * it hard-deletes the page rows, and nothing FK-cascades the denormalized
 * `machines` blobs on agent pages / the global assistant config. The MACHINE
 * page ids must therefore be snapshotted BEFORE the delete (afterwards the rows
 * are gone and the set is unrecoverable), and swept afterwards.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockFindPage,
  mockTransaction,
  mockExecute,
  mockCanDelete,
  mockAuthenticate,
  mockReapOrphanedFiles,
  mockCollectMachineIds,
  mockSweepMachineRefs,
  callOrder,
} = vi.hoisted(() => {
  const order: string[] = [];
  return {
    mockFindPage: vi.fn(),
    mockTransaction: vi.fn(),
    mockExecute: vi.fn(),
    mockCanDelete: vi.fn(),
    mockAuthenticate: vi.fn(),
    mockReapOrphanedFiles: vi.fn(),
    mockCollectMachineIds: vi.fn(),
    mockSweepMachineRefs: vi.fn(),
    callOrder: order,
  };
});

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { pages: { findFirst: (...args: unknown[]) => mockFindPage(...args) } },
    execute: (...args: unknown[]) => mockExecute(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values })),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: {}, favorites: {}, pageTags: {}, chatMessages: {},
}));
vi.mock('@pagespace/db/schema/members', () => ({ pagePermissions: {} }));
vi.mock('@pagespace/db/schema/chat', () => ({ channelMessages: {} }));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticate(...args),
  isAuthError: (value: unknown) => typeof value === 'object' && value !== null && 'error' in value,
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserDeletePage: (...args: unknown[]) => mockCanDelete(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn(async () => ({ actorEmail: 'a@x.test', actorDisplayName: 'A' })),
  logPageActivity: vi.fn(),
}));
vi.mock('@/lib/storage/reap-orphaned-files', () => ({
  reapOrphanedFiles: (...args: unknown[]) => mockReapOrphanedFiles(...args),
}));
vi.mock('@/lib/machines/machine-ref-sweep-runtime', () => ({
  collectMachinePageIdsInSubtree: (...args: unknown[]) => mockCollectMachineIds(...args),
  sweepDanglingMachineRefs: (...args: unknown[]) => mockSweepMachineRefs(...args),
}));
vi.mock('next/server', () => ({
  NextResponse: Object.assign(
    function NextResponse(body: string, init?: ResponseInit) {
      return new Response(body, init);
    },
    {
      json: (body: unknown, init?: ResponseInit) =>
        new Response(JSON.stringify(body), { status: init?.status ?? 200 }),
    },
  ),
}));

import { DELETE } from '../route';

function makeRequest(): Request {
  return new Request('http://localhost:3000/api/trash/page-1', { method: 'DELETE' });
}

const params = Promise.resolve({ pageId: 'page-1' });

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  mockAuthenticate.mockResolvedValue({ userId: 'user-1' });
  mockCanDelete.mockResolvedValue(true);
  mockFindPage.mockResolvedValue({ id: 'page-1', title: 'Folder', driveId: 'drive-1', isTrashed: true });
  mockExecute.mockResolvedValue({ rows: [] });
  mockTransaction.mockImplementation(async () => {
    callOrder.push('delete');
  });
  mockReapOrphanedFiles.mockResolvedValue({ dbRecordsDeleted: 0 });
  mockCollectMachineIds.mockImplementation(async () => {
    callOrder.push('collect');
    return ['machine-1'];
  });
  mockSweepMachineRefs.mockImplementation(async () => {
    callOrder.push('sweep');
    return { deadMachineIds: ['machine-1'], agentsUpdated: 1, globalConfigsUpdated: 0, failures: 0 };
  });
});

describe('DELETE /api/trash/[pageId]', () => {
  it('snapshots the subtree MACHINE ids before deleting and sweeps their refs after', async () => {
    const response = await DELETE(makeRequest(), { params });

    expect(response.status).toBe(200);
    expect(mockCollectMachineIds).toHaveBeenCalledWith('page-1');
    expect(mockSweepMachineRefs).toHaveBeenCalledWith(['machine-1']);
    // Order is the whole point: after the delete the rows are gone, so a
    // snapshot taken then would come back empty.
    expect(callOrder).toEqual(['collect', 'delete', 'sweep']);
  });

  it('skips the sweep entirely when the subtree held no machines', async () => {
    mockCollectMachineIds.mockResolvedValue([]);

    await DELETE(makeRequest(), { params });

    expect(mockSweepMachineRefs).not.toHaveBeenCalled();
  });

  it('still reports success when the sweep fails', async () => {
    mockSweepMachineRefs.mockRejectedValue(new Error('deadlock detected'));

    const response = await DELETE(makeRequest(), { params });

    expect(response.status).toBe(200);
  });

  it('does not sweep when the page is not in the trash', async () => {
    mockFindPage.mockResolvedValue({ id: 'page-1', isTrashed: false, driveId: 'drive-1' });

    const response = await DELETE(makeRequest(), { params });

    expect(response.status).toBe(400);
    expect(mockSweepMachineRefs).not.toHaveBeenCalled();
  });
});
