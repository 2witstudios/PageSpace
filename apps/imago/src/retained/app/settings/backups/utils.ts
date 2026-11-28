import type { DriveBackupWithDriveName } from '@/retained-adapters/ui-contracts';

/** A backup as the backups list returns it, with its dates as ISO strings. */
export type SerializedBackup = Omit<DriveBackupWithDriveName, 'createdAt' | 'completedAt' | 'failedAt'> & {
  createdAt: string;
  completedAt: string | null;
  failedAt: string | null;
};

export function getExportFilename(
  backupId: string,
  label: string | null | undefined,
  driveSlug?: string | null,
): string {
  const slug = driveSlug ? `${driveSlug}-` : '';
  return label ? `${slug}${label}.zip` : `${slug}backup-${backupId}.zip`;
}

export function getDownloadButtonLabel(isDownloading: boolean): string {
  return isDownloading ? 'Downloading…' : 'Download';
}

/** The board's source pill: Manual, Scheduled, Safety snapshot (pre-restore) or System. */
export function sourceLabel(source: string): string {
  if (source === 'manual') return 'Manual';
  if (source === 'pre_restore') return 'Safety snapshot';
  if (source === 'scheduled') return 'Scheduled';
  if (source === 'system') return 'System';
  return source;
}

/** Status pill copy: ready, pending or failed. */
export function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'ready') return 'default';
  if (status === 'failed') return 'destructive';
  return 'secondary';
}
