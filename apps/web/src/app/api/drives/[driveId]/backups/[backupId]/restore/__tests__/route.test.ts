import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isDriveOwnerOrAdmin: vi.fn(),
}));
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      driveBackups: {
        findFirst: vi.fn(),
      },
    },
    transaction: vi.fn(),
  },
}));
vi.mock('@/services/api/restore-backup-service', () => ({
  runPreRestoreSnapshot: vi.fn(),
  decideSnapshotLabel: vi.fn().mockReturnValue('label'),
}));
vi.mock('@pagespace/lib/monitoring/change-group', () => ({
  createChangeGroupId: vi.fn().mockReturnValue('cg-1'),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db/db';
import { runPreRestoreSnapshot } from '@/services/api/restore-backup-service';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const mockAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sid',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const makeRequest = (driveId: string, backupId: string) =>
  new Request(`https://example.com/api/drives/${driveId}/backups/${backupId}/restore`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

const makeParams = (driveId: string, backupId: string) => ({
  params: Promise.resolve({ driveId, backupId }),
});

const readyBackup = { id: 'backup_1', driveId: 'drive_1', status: 'ready' };

const successTxResult = {
  pagesCreated: 1,
  pagesOverwritten: 0,
  pagesOrphaned: 0,
  skippedMembers: [],
};

describe('POST /api/drives/[driveId]/backups/[backupId]/restore', () => {
  const userId = 'user_1';
  const driveId = 'drive_1';
  const backupId = 'backup_1';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth(userId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(true);
    vi.mocked(db.query.driveBackups.findFirst).mockResolvedValue(readyBackup as never);
    vi.mocked(runPreRestoreSnapshot).mockResolvedValue({ success: true, preRestoreBackupId: 'snap-1' });
    vi.mocked(db.transaction).mockResolvedValue(successTxResult as never);
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));
    const res = await POST(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(401);
  });

  it('returns 403 when not CSRF authenticated (requireCSRF: true check)', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(403));
    const res = await POST(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(403);
  });

  it('returns 403 when not drive owner or admin', async () => {
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);
    const res = await POST(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(403);
  });

  it('returns 400 when backup not found', async () => {
    vi.mocked(db.query.driveBackups.findFirst).mockResolvedValue(undefined as never);
    const res = await POST(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(400);
  });

  it('returns 400 when backup driveId does not match route driveId', async () => {
    vi.mocked(db.query.driveBackups.findFirst).mockResolvedValue({ ...readyBackup, driveId: 'other-drive' } as never);
    const res = await POST(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(400);
  });

  it('returns 409 when backup status is pending', async () => {
    vi.mocked(db.query.driveBackups.findFirst).mockResolvedValue({ ...readyBackup, status: 'pending' } as never);
    const res = await POST(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(409);
  });

  it('returns 409 when backup status is failed', async () => {
    vi.mocked(db.query.driveBackups.findFirst).mockResolvedValue({ ...readyBackup, status: 'failed' } as never);
    const res = await POST(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(409);
  });

  it('returns 500 when pre-restore snapshot fails, page-write functions not called', async () => {
    vi.mocked(runPreRestoreSnapshot).mockResolvedValue({ success: false, error: 'disk full' });
    const res = await POST(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(500);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('returns 200 with correct shape on success', async () => {
    const res = await POST(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      preRestoreBackupId: 'snap-1',
      counts: expect.objectContaining({
        pagesCreated: expect.any(Number),
        pagesOverwritten: expect.any(Number),
        pagesOrphaned: expect.any(Number),
        skippedMembers: expect.any(Array),
      }),
    });
  });

  it('calls auditRequest with operation: restore_backup on success', async () => {
    await POST(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({ operation: 'restore_backup', backupId }),
      }),
    );
  });

  it('calls runPreRestoreSnapshot before entering the restore transaction', async () => {
    let snapshotCalledAt = -1;
    let txCalledAt = -1;
    let callIndex = 0;

    vi.mocked(runPreRestoreSnapshot).mockImplementation(async () => {
      snapshotCalledAt = callIndex++;
      return { success: true, preRestoreBackupId: 'snap-1' };
    });
    vi.mocked(db.transaction).mockImplementation(async () => {
      txCalledAt = callIndex++;
      return successTxResult;
    });

    await POST(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(snapshotCalledAt).toBeLessThan(txCalledAt);
  });
});
