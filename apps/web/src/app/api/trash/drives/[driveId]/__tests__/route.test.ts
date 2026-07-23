/**
 * Permanent drive delete — the machine-ref repair (issue #2156).
 *
 * Deleting the drive FK-cascades its pages away, MACHINE pages included, so the
 * denormalized `machines` blobs elsewhere are left pointing at nothing. The ids
 * must be snapshotted before the delete and swept after.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockFindDrive,
  mockDeleteWhere,
  mockAuthenticate,
  mockGetRecipients,
  mockBroadcast,
  mockCollectMachineIds,
  mockSweepMachineRefs,
  callOrder,
} = vi.hoisted(() => {
  const order: string[] = [];
  return {
    mockFindDrive: vi.fn(),
    mockDeleteWhere: vi.fn(),
    mockAuthenticate: vi.fn(),
    mockGetRecipients: vi.fn(),
    mockBroadcast: vi.fn(),
    mockCollectMachineIds: vi.fn(),
    mockSweepMachineRefs: vi.fn(),
    callOrder: order,
  };
});

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { drives: { findFirst: (...args: unknown[]) => mockFindDrive(...args) } },
    delete: () => ({ where: (...args: unknown[]) => mockDeleteWhere(...args) }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
}));
vi.mock('@pagespace/db/schema/core', () => ({ drives: {} }));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticate(...args),
  isAuthError: (value: unknown) => typeof value === 'object' && value !== null && 'error' in value,
}));
vi.mock('@pagespace/lib/services/drive-guards', () => ({
  isHomeDrive: vi.fn(() => false),
  homeDriveActionError: vi.fn(() => 'nope'),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@/lib/websocket', () => ({
  broadcastDriveEvent: (...args: unknown[]) => mockBroadcast(...args),
  createDriveEventPayload: vi.fn((...args: unknown[]) => args),
}));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: (...args: unknown[]) => mockGetRecipients(...args),
}));
vi.mock('@/lib/machines/machine-ref-sweep-runtime', () => ({
  collectMachinePageIdsInDrive: (...args: unknown[]) => mockCollectMachineIds(...args),
  sweepDanglingMachineRefs: (...args: unknown[]) => mockSweepMachineRefs(...args),
}));
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { status: init?.status ?? 200 }),
  },
}));

import { DELETE } from '../route';

function makeRequest(): Request {
  return new Request('http://localhost:3000/api/trash/drives/drive-1', { method: 'DELETE' });
}

const context = { params: Promise.resolve({ driveId: 'drive-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  mockAuthenticate.mockResolvedValue({ userId: 'user-1' });
  mockFindDrive.mockResolvedValue({ id: 'drive-1', name: 'Work', slug: 'work', isTrashed: true, ownerId: 'user-1' });
  mockGetRecipients.mockResolvedValue(['user-1']);
  mockBroadcast.mockResolvedValue(undefined);
  mockDeleteWhere.mockImplementation(async () => {
    callOrder.push('delete');
  });
  mockCollectMachineIds.mockImplementation(async () => {
    callOrder.push('collect');
    return ['machine-1'];
  });
  mockSweepMachineRefs.mockImplementation(async () => {
    callOrder.push('sweep');
    return { deadMachineIds: ['machine-1'], agentsUpdated: 1, globalConfigsUpdated: 1, failures: 0 };
  });
});

describe('DELETE /api/trash/drives/[driveId]', () => {
  it('snapshots the drive MACHINE ids before deleting and sweeps their refs after', async () => {
    const response = await DELETE(makeRequest(), context);

    expect(response.status).toBe(200);
    expect(mockCollectMachineIds).toHaveBeenCalledWith('drive-1');
    expect(mockSweepMachineRefs).toHaveBeenCalledWith(['machine-1']);
    expect(callOrder).toEqual(['collect', 'delete', 'sweep']);
  });

  it('skips the sweep when the drive held no machines', async () => {
    mockCollectMachineIds.mockResolvedValue([]);

    await DELETE(makeRequest(), context);

    expect(mockSweepMachineRefs).not.toHaveBeenCalled();
  });

  it('still reports success when the sweep fails', async () => {
    mockSweepMachineRefs.mockRejectedValue(new Error('deadlock detected'));

    const response = await DELETE(makeRequest(), context);

    expect(response.status).toBe(200);
  });

  it('does not sweep when the drive is not in the trash', async () => {
    mockFindDrive.mockResolvedValue({ id: 'drive-1', isTrashed: false });

    const response = await DELETE(makeRequest(), context);

    expect(response.status).toBe(400);
    expect(mockCollectMachineIds).not.toHaveBeenCalled();
    expect(mockSweepMachineRefs).not.toHaveBeenCalled();
  });
});
