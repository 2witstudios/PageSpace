/**
 * Contract tests for /api/cron/cleanup-orphaned-files
 * Verifies security audit logging on successful orphaned file cleanup.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFindOrphans, mockDeleteRecords, mockAudit, mockCreateServiceToken } = vi.hoisted(() => ({
  mockFindOrphans: vi.fn(),
  mockDeleteRecords: vi.fn(),
  mockAudit: vi.fn(),
  mockCreateServiceToken: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/compliance/file-cleanup/orphan-detector', () => ({
  findOrphanedFileRecords: mockFindOrphans,
  deleteFileRecords: mockDeleteRecords,
}));

vi.mock('@pagespace/db', () => ({
  db: {},
}));

vi.mock('@pagespace/lib/services/validated-service-token', () => ({
  createDriveServiceToken: mockCreateServiceToken,
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

describe('/api/cron/cleanup-orphaned-files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    // No orphans by default
    mockFindOrphans.mockResolvedValue([]);
  });

  it('logs audit event when no orphans found', async () => {
    await GET(makeRequest());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'data.delete', resourceType: 'cron_job', resourceId: 'cleanup_orphaned_files', details: { orphansFound: 0, filesDeleted: 0, physicalFilesDeleted: 0 } })
    );
  });

  it('logs audit event with counts on successful cleanup', async () => {
    const orphans = [
      { id: 'f1', storagePath: null, driveId: 'd1' },
      { id: 'f2', storagePath: null, driveId: 'd1' },
    ];
    mockFindOrphans.mockResolvedValue(orphans);
    mockDeleteRecords.mockResolvedValue(2);

    await GET(makeRequest());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'data.delete', resourceType: 'cron_job', resourceId: 'cleanup_orphaned_files', details: { orphansFound: 2, filesDeleted: 2, physicalFilesDeleted: 0 } })
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
});
