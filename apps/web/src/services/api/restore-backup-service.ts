import { createDriveBackup } from '@/services/api/drive-backup-service';
import type { AccessActor } from '@pagespace/lib/permissions/access-actor';

export function decideSnapshotLabel(backupId: string): string {
  return `Auto-snapshot before restoring from ${backupId}`;
}

export function snapshotIsRequired(): true {
  return true;
}

type PreRestoreResult =
  | { success: true; preRestoreBackupId: string; error?: undefined }
  | { success: false; error: string; preRestoreBackupId?: undefined };

export async function runPreRestoreSnapshot(
  driveId: string,
  actor: AccessActor,
  backupId: string,
): Promise<PreRestoreResult> {
  try {
    const result = await createDriveBackup(driveId, actor, {
      source: 'pre_restore',
      label: decideSnapshotLabel(backupId),
    });

    if (!result.success || !result.backupId) {
      return {
        success: false,
        error: `Pre-restore snapshot failed: ${result.error ?? 'unknown error'}`,
      };
    }

    return { success: true, preRestoreBackupId: result.backupId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Pre-restore snapshot failed: ${message}` };
  }
}
