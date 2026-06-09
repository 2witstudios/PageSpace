import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decideSnapshotLabel, snapshotIsRequired } from '../restore-backup-service';

vi.mock('@/services/api/drive-backup-service', () => ({
  createDriveBackup: vi.fn(),
}));

import { createDriveBackup } from '@/services/api/drive-backup-service';
import { runPreRestoreSnapshot } from '../restore-backup-service';

// ============================================================================
// Pure function tests (zero mocks, zero I/O)
// ============================================================================

describe('decideSnapshotLabel', () => {
  it('returns expected label string', () => {
    expect(decideSnapshotLabel('abc123')).toBe(
      'Auto-snapshot before restoring from abc123',
    );
  });

  it('includes backupId in the label', () => {
    expect(decideSnapshotLabel('xyz')).toContain('xyz');
  });
});

describe('snapshotIsRequired', () => {
  it('is always true', () => {
    expect(snapshotIsRequired()).toBe(true);
  });
});

// ============================================================================
// runPreRestoreSnapshot — integration tests (mock createDriveBackup)
// ============================================================================

describe('runPreRestoreSnapshot', () => {
  const driveId = 'drive_1';
  const userId = 'user_1';
  const backupId = 'backup_1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns failure when createDriveBackup returns { success: false }', async () => {
    vi.mocked(createDriveBackup).mockResolvedValue({
      success: false,
      error: 'disk full',
    } as never);

    const result = await runPreRestoreSnapshot(driveId, userId, backupId);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Pre-restore snapshot failed');
    expect(result.error).toContain('disk full');
  });

  it('returns failure when createDriveBackup throws', async () => {
    vi.mocked(createDriveBackup).mockRejectedValue(new Error('network error'));

    const result = await runPreRestoreSnapshot(driveId, userId, backupId);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Pre-restore snapshot failed');
  });

  it('returns success with preRestoreBackupId when createDriveBackup succeeds', async () => {
    vi.mocked(createDriveBackup).mockResolvedValue({
      success: true,
      backupId: 'snap-1',
      status: 'ready',
      counts: { pages: 5, permissions: 0, members: 0, roles: 0, files: 0 },
    } as never);

    const result = await runPreRestoreSnapshot(driveId, userId, backupId);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.preRestoreBackupId).toBe('snap-1');
    }
  });

  it('calls createDriveBackup with source: pre_restore and correct label', async () => {
    vi.mocked(createDriveBackup).mockResolvedValue({
      success: true,
      backupId: 'snap-2',
      status: 'ready',
      counts: { pages: 0, permissions: 0, members: 0, roles: 0, files: 0 },
    } as never);

    await runPreRestoreSnapshot(driveId, userId, backupId);

    expect(createDriveBackup).toHaveBeenCalledWith(
      driveId,
      userId,
      expect.objectContaining({
        source: 'pre_restore',
        label: decideSnapshotLabel(backupId),
      }),
    );
  });
});
