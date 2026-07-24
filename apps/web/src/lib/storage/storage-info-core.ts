/**
 * Pure core for GET /api/storage/info (#2155).
 *
 * The route used to aggregate `pages.fileSize` (per-page copy metadata), while
 * quota/billing reads `users.storageUsedBytes` and reconciliation sums
 * `files.sizeBytes` — three surfaces with three different totals, legitimately
 * disagreeing under dedup (N pages can share one blob). This core instead
 * shapes the same population reconcile/charge use — `files` rows the user
 * created — into the breakdown/largest/recent/by-drive views the UI shows, so
 * a user never sees a number here that differs from the one that blocks their
 * upload.
 */

export interface UserFileRow {
  fileId: string;
  sizeBytes: number;
  mimeType: string | null;
  createdAt: Date;
  /** Null for files with no drive-page linkage (e.g. DM-only attachments). */
  driveId: string | null;
  /** The page this row is displayed as (first/primary link), if any. */
  pageId: string | null;
  title: string | null;
}

export function getFileTypeCategory(mimeType: string | null): string {
  if (!mimeType || mimeType === 'unknown') return 'Other';

  if (mimeType.startsWith('image/')) return 'Images';
  if (mimeType.startsWith('video/')) return 'Videos';
  if (mimeType.startsWith('audio/')) return 'Audio';
  if (mimeType.startsWith('text/')) return 'Text';
  if (mimeType.includes('pdf')) return 'PDFs';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'Documents';
  if (mimeType.includes('sheet') || mimeType.includes('excel')) return 'Spreadsheets';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'Presentations';
  if (mimeType.includes('zip') || mimeType.includes('compress') || mimeType.includes('archive')) return 'Archives';

  return 'Other';
}

export function buildFileTypeBreakdown(
  rows: ReadonlyArray<UserFileRow>,
): Record<string, { count: number; totalSize: number }> {
  const breakdown: Record<string, { count: number; totalSize: number }> = {};
  for (const row of rows) {
    const category = getFileTypeCategory(row.mimeType);
    if (!breakdown[category]) breakdown[category] = { count: 0, totalSize: 0 };
    breakdown[category].count++;
    breakdown[category].totalSize += row.sizeBytes;
  }
  return breakdown;
}

export function pickLargestFiles(rows: ReadonlyArray<UserFileRow>, limit: number): UserFileRow[] {
  return [...rows].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, limit);
}

export function pickRecentFiles(rows: ReadonlyArray<UserFileRow>, limit: number): UserFileRow[] {
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
}

export interface DriveStorageSummary {
  driveId: string;
  driveName: string;
  fileCount: number;
  totalSize: number;
}

/** Files with no driveId (DM attachments) count toward the overall total but no per-drive bucket. */
export function buildStorageByDrive(
  rows: ReadonlyArray<UserFileRow>,
  drives: ReadonlyArray<{ id: string; name: string }>,
): DriveStorageSummary[] {
  return drives.map((drive) => {
    const driveFiles = rows.filter((r) => r.driveId === drive.id);
    return {
      driveId: drive.id,
      driveName: drive.name,
      fileCount: driveFiles.length,
      totalSize: driveFiles.reduce((sum, r) => sum + r.sizeBytes, 0),
    };
  });
}
