import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockFindOrphans,
  mockDeleteRecords,
  mockCreateSystemFileDeleteToken,
  mockUpdateStorageUsage,
  mockFindDriveOrgIds,
} = vi.hoisted(() => ({
  mockFindDriveOrgIds: vi.fn(),
  mockFindOrphans: vi.fn(),
  mockDeleteRecords: vi.fn(),
  mockCreateSystemFileDeleteToken: vi.fn(),
  mockUpdateStorageUsage: vi.fn(),
}));

vi.mock('@pagespace/lib/compliance/file-cleanup/orphan-detector', () => ({
  findOrphanedFileRecords: mockFindOrphans,
  deleteFileRecords: mockDeleteRecords,
}));

vi.mock('@pagespace/lib/services/validated-service-token', () => ({
  createSystemFileDeleteToken: mockCreateSystemFileDeleteToken,
}));

vi.mock('@pagespace/lib/services/storage-limits', () => ({
  updateStorageUsage: mockUpdateStorageUsage,
  findDriveOrgIds: mockFindDriveOrgIds,
  // Mirrors the pure impl so the reaper's credit rules are exercised, not stubbed.
  computeStorageCreditOnUnlink: (input: {
    createdBy: string | null;
    driveOrgId: string | null;
    sizeBytes: number | string | null;
    deletedByThisCall: boolean;
    hadPhysicalBlob: boolean;
  }) => {
    if (!input.deletedByThisCall || !input.hadPhysicalBlob || !input.createdBy) return null;
    if (input.driveOrgId !== null) return null;
    const n = typeof input.sizeBytes === 'string' ? Number(input.sizeBytes) : (input.sizeBytes ?? 0);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { userId: input.createdBy, deltaBytes: -Math.floor(n) };
  },
}));

import { reapOrphanedFiles } from '../reap-orphaned-files';

const db = {} as never;

const orphan = (overrides: Partial<{ id: string; storagePath: string; driveId: string | null; sizeBytes: number; createdBy: string | null }> = {}) => ({
  id: overrides.id ?? 'f1',
  storagePath: overrides.storagePath ?? '/storage/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/original',
  driveId: 'driveId' in overrides ? overrides.driveId ?? null : 'd1',
  sizeBytes: overrides.sizeBytes ?? 1024,
  createdBy: 'createdBy' in overrides ? overrides.createdBy ?? null : 'u1',
});

describe('reapOrphanedFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOrphans.mockResolvedValue([]);
    mockDeleteRecords.mockResolvedValue([]);
    mockCreateSystemFileDeleteToken.mockResolvedValue({ token: 'sys-tok' });
    mockUpdateStorageUsage.mockResolvedValue(undefined);
    mockFindDriveOrgIds.mockResolvedValue(new Map([['d1', null]]));
  });

  it('forwards an explicit fileIds list to findOrphanedFileRecords (scoped reap)', async () => {
    await reapOrphanedFiles(db, { fileIds: ['a', 'b'] });
    expect(mockFindOrphans).toHaveBeenCalledWith(db, ['a', 'b']);
  });

  it('passes undefined to findOrphanedFileRecords when no options (global sweep)', async () => {
    await reapOrphanedFiles(db);
    expect(mockFindOrphans).toHaveBeenCalledWith(db, undefined);
  });

  it('does no processor work and returns zeros when no orphans are found', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await reapOrphanedFiles(db, { fileIds: ['none'] });

    expect(result).toEqual({ orphansFound: 0, physicalFilesDeleted: 0, dbRecordsDeleted: 0, failedPhysicalDeletes: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockDeleteRecords).not.toHaveBeenCalled();
    expect(mockUpdateStorageUsage).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('credits the uploader only for rows this call actually deleted (race-safe)', async () => {
    mockFindOrphans.mockResolvedValue([orphan({ id: 'f1', sizeBytes: 2048, createdBy: 'u1' })]);
    mockDeleteRecords.mockResolvedValue(['f1']);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));

    const result = await reapOrphanedFiles(db, { fileIds: ['f1'] });

    expect(mockUpdateStorageUsage).toHaveBeenCalledWith('u1', -2048, expect.objectContaining({ eventType: 'delete' }));
    expect(result.physicalFilesDeleted).toBe(1);
    expect(result.dbRecordsDeleted).toBe(1);

    vi.unstubAllGlobals();
  });

  it('WAL-9 (partial) does NOT credit the uploader for a reaped file in an org drive: the org was billed, not them', async () => {
    mockFindOrphans.mockResolvedValue([orphan({ id: 'f1', driveId: 'org-drive', sizeBytes: 2048, createdBy: 'u1' })]);
    mockDeleteRecords.mockResolvedValue(['f1']);
    mockFindDriveOrgIds.mockResolvedValue(new Map([['org-drive', 'org-northwind']]));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));

    const result = await reapOrphanedFiles(db, { fileIds: ['f1'] });

    expect(mockFindDriveOrgIds).toHaveBeenCalledWith(['org-drive']);
    expect(mockUpdateStorageUsage).not.toHaveBeenCalled();
    expect(result.dbRecordsDeleted).toBe(1);

    vi.unstubAllGlobals();
  });

  it('does NOT credit when the row was deleted by a racing reap (not in this call\'s deleted set)', async () => {
    mockFindOrphans.mockResolvedValue([orphan({ id: 'f1' })]);
    // Physical delete succeeded, but another reap already removed the DB row,
    // so deleteFileRecords returns it as NOT deleted by this call.
    mockDeleteRecords.mockResolvedValue([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));

    await reapOrphanedFiles(db, { fileIds: ['f1'] });

    expect(mockUpdateStorageUsage).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('does not credit when the physical delete fails (row left for retry)', async () => {
    mockFindOrphans.mockResolvedValue([orphan({ id: 'f1' })]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));

    const result = await reapOrphanedFiles(db);

    expect(mockUpdateStorageUsage).not.toHaveBeenCalled();
    expect(mockDeleteRecords).not.toHaveBeenCalled();
    expect(result.failedPhysicalDeletes).toEqual(['f1']);

    vi.unstubAllGlobals();
  });
});
