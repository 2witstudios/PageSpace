/**
 * Contract tests for /api/cron/cleanup-orphaned-files
 *
 * After PR 7 (DM lifecycle + orphan GC) the cron now:
 *   1. Mints a system file-bound delete token for null-drive orphans
 *      (conversation-only files), so DM-attached files are reaped.
 *   2. Decrements the uploader's storageUsedBytes by exactly -sizeBytes for
 *      every orphan that was physically deleted (drive AND null-drive).
 *   3. Skips storage credit for orphans whose physical delete failed; the
 *      DB row stays so the orphan is retried next run.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockFindOrphans,
  mockDeleteRecords,
  mockAudit,
  mockCreateDriveToken,
  mockCreateSystemFileDeleteToken,
  mockUpdateStorageUsage,
} = vi.hoisted(() => ({
  mockFindOrphans: vi.fn(),
  mockDeleteRecords: vi.fn(),
  mockAudit: vi.fn(),
  mockCreateDriveToken: vi.fn(),
  mockCreateSystemFileDeleteToken: vi.fn(),
  mockUpdateStorageUsage: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/compliance/file-cleanup/orphan-detector', () => ({
  findOrphanedFileRecords: mockFindOrphans,
  deleteFileRecords: mockDeleteRecords,
}));

vi.mock('@pagespace/db/db', () => ({
  db: {},
}));

vi.mock('@pagespace/lib/services/validated-service-token', () => ({
  createDriveServiceToken: mockCreateDriveToken,
  createSystemFileDeleteToken: mockCreateSystemFileDeleteToken,
}));

vi.mock('@pagespace/lib/services/storage-limits', () => ({
  updateStorageUsage: mockUpdateStorageUsage,
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: mockAudit,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

import { GET } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

function makeRequest(): Request {
  return new Request('http://localhost:3000/api/cron/cleanup-orphaned-files');
}

const driveOrphan = (overrides: Partial<{
  id: string;
  storagePath: string;
  driveId: string;
  sizeBytes: number;
  createdBy: string;
}> = {}) => ({
  id: overrides.id ?? 'f_drive',
  storagePath: overrides.storagePath ?? '/storage/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/original',
  driveId: overrides.driveId ?? 'd_1',
  sizeBytes: overrides.sizeBytes ?? 1024,
  createdBy: overrides.createdBy ?? 'user_uploader_drive',
});

const nullDriveOrphan = (overrides: Partial<{
  id: string;
  storagePath: string;
  sizeBytes: number;
  createdBy: string;
}> = {}) => ({
  id: overrides.id ?? 'f_null',
  storagePath: overrides.storagePath ?? '/storage/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/original',
  driveId: null,
  sizeBytes: overrides.sizeBytes ?? 4096,
  createdBy: overrides.createdBy ?? 'user_uploader_dm',
});

describe('/api/cron/cleanup-orphaned-files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockFindOrphans.mockResolvedValue([]);
    // By default, both token mints succeed.
    mockCreateDriveToken.mockResolvedValue({ token: 'drive-tok', grantedScopes: ['files:delete'] });
    mockCreateSystemFileDeleteToken.mockResolvedValue({ token: 'sys-tok', grantedScopes: ['files:delete'] });
    mockDeleteRecords.mockResolvedValue(0);
    mockUpdateStorageUsage.mockResolvedValue(undefined);
  });

  it('logs audit event when no orphans found', async () => {
    await GET(makeRequest());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'data.delete', resourceType: 'cron_job', resourceId: 'cleanup_orphaned_files', details: { orphansFound: 0, filesDeleted: 0, physicalFilesDeleted: 0 } })
    );
  });

  it('does not log audit event when auth fails', async () => {
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    await GET(makeRequest());

    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('does not log audit event when cleanup throws', async () => {
    mockFindOrphans.mockRejectedValue(new Error('DB error'));

    await GET(makeRequest());

    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('cron_nullDriveOrphan_isReclaimed_notDeferred', async () => {
    const orphan = nullDriveOrphan();
    mockFindOrphans.mockResolvedValue([orphan]);
    mockDeleteRecords.mockResolvedValue(1);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await GET(makeRequest());

    // The system token mint MUST be exercised — null-drive orphans no longer
    // defer; they reach the processor like any other orphan.
    expect(mockCreateSystemFileDeleteToken).toHaveBeenCalledTimes(1);
    expect(mockDeleteRecords).toHaveBeenCalledWith(expect.anything(), [orphan.id]);

    vi.unstubAllGlobals();
  });

  it('cron_nullDriveOrphan_creditsUploaderStorageBy_negativeSizeBytes', async () => {
    // Boundary obligation: the uploader's quota MUST be credited back by the
    // exact size of the reclaimed orphan, attributed to createdBy.
    const orphan = nullDriveOrphan({ sizeBytes: 4096, createdBy: 'user_dm_uploader' });
    mockFindOrphans.mockResolvedValue([orphan]);
    mockDeleteRecords.mockResolvedValue(1);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await GET(makeRequest());

    expect(mockUpdateStorageUsage).toHaveBeenCalledWith(
      'user_dm_uploader',
      -4096,
      expect.objectContaining({ eventType: 'delete' })
    );

    vi.unstubAllGlobals();
  });

  it('cron_driveOrphan_unchangedBehavior_stillReclaimed_andCreditsStorage', async () => {
    const orphan = driveOrphan({ sizeBytes: 1024, createdBy: 'user_drive_uploader' });
    mockFindOrphans.mockResolvedValue([orphan]);
    mockDeleteRecords.mockResolvedValue(1);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await GET(makeRequest());

    // Drive orphans still mint a drive-scoped token (existing behavior).
    expect(mockCreateDriveToken).toHaveBeenCalledTimes(1);
    expect(mockCreateSystemFileDeleteToken).not.toHaveBeenCalled();
    expect(mockDeleteRecords).toHaveBeenCalledWith(expect.anything(), [orphan.id]);
    expect(mockUpdateStorageUsage).toHaveBeenCalledWith(
      'user_drive_uploader',
      -1024,
      expect.objectContaining({ eventType: 'delete' })
    );

    vi.unstubAllGlobals();
  });

  it('cron_orphanWithFailedPhysicalDelete_doesNotCreditStorage_andRetriesNextRun', async () => {
    // If the processor 500s, the row stays so it retries next cron tick.
    // The uploader's quota MUST NOT be credited until the blob is actually gone.
    const orphan = nullDriveOrphan({ sizeBytes: 8192 });
    mockFindOrphans.mockResolvedValue([orphan]);
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await GET(makeRequest());

    expect(mockUpdateStorageUsage).not.toHaveBeenCalled();
    // DB row not deleted on failure — orphan retries next run.
    expect(mockDeleteRecords).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('cron_orphanWithoutCreatedBy_skipsStorageCreditButStillReclaimsBlob', async () => {
    // Orphans can predate the createdBy column (set null on user delete), in
    // which case there's nothing to credit. The blob must still be reclaimed.
    const orphan = { ...nullDriveOrphan(), createdBy: null as string | null };
    mockFindOrphans.mockResolvedValue([orphan]);
    mockDeleteRecords.mockResolvedValue(1);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await GET(makeRequest());

    expect(mockUpdateStorageUsage).not.toHaveBeenCalled();
    expect(mockDeleteRecords).toHaveBeenCalledWith(expect.anything(), [orphan.id]);

    vi.unstubAllGlobals();
  });

  it('cron_audit_includesPhysicalAndDbCounts_acrossMixedOrphanShapes', async () => {
    // Two orphans (one drive, one null-drive); both succeed → audit shows both.
    mockFindOrphans.mockResolvedValue([driveOrphan(), nullDriveOrphan()]);
    mockDeleteRecords.mockResolvedValue(2);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await GET(makeRequest());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'data.delete',
        resourceType: 'cron_job',
        details: { orphansFound: 2, filesDeleted: 2, physicalFilesDeleted: 2 },
      })
    );

    vi.unstubAllGlobals();
  });
});
