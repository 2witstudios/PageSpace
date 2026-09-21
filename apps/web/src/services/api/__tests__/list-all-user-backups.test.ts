import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSelect, mockInArray } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInArray: vi.fn((column: unknown, values: unknown[]) => ({ inArray: [column, values] })),
}));

vi.mock('@pagespace/db/db', () => ({ db: { select: mockSelect } }));
vi.mock('@pagespace/db/operators', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/db/operators')>()),
  inArray: mockInArray,
}));
// The one member-drive listing (org-aware; owned drives plus accepted rows while dark).
vi.mock('@pagespace/lib/permissions/member-drives', () => ({
  getAdministeredDriveIds: vi.fn(),
}));

import { listAllUserBackups } from '../drive-backup-service';
import { getAdministeredDriveIds } from '@pagespace/lib/permissions/member-drives';

function stubBackupQueries() {
  const rowsChain = { from: () => rowsChain, innerJoin: () => rowsChain, where: () => rowsChain, orderBy: () => rowsChain, limit: () => rowsChain, offset: async () => [] };
  const countChain = { from: () => countChain, where: async () => [{ count: 0 }] };
  mockSelect.mockImplementationOnce(() => rowsChain).mockImplementationOnce(() => countChain);
}

describe('listAllUserBackups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ORG-4 (partial) X-6 (partial) lists backups of every drive the user leads or administers, from the org-aware getAdministeredDriveIds (an org Admin\'s unjoined PRIVATE drive included, never a stale org row), never a drive_members read of its own', async () => {
    vi.mocked(getAdministeredDriveIds).mockResolvedValueOnce(['led', 'org-private-unjoined']);
    stubBackupQueries();

    const result = await listAllUserBackups('user-1');

    expect(result).toEqual({ success: true, backups: [], total: 0 });
    expect(getAdministeredDriveIds).toHaveBeenCalledWith('user-1', { includeTrashed: false });
    expect(mockInArray.mock.calls.map(([, values]) => values)).toEqual([['led', 'org-private-unjoined'], ['led', 'org-private-unjoined']]);
  });

  it('returns nothing, and runs no backup query, when the user leads and administers no drive', async () => {
    vi.mocked(getAdministeredDriveIds).mockResolvedValueOnce([]);

    expect(await listAllUserBackups('user-1')).toEqual({ success: true, backups: [], total: 0 });
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
