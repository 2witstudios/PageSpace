import { formatDistanceToNow } from 'date-fns';

/** apps/web's storage summary for the viewer's own files (GET /api/storage/info). */
export const STORAGE_INFO = '/api/storage/info';

/** The three bar segments the board draws; every other category is "Other". */
export type StorageTypeLabel = 'PDF' | 'Images' | 'Video' | 'Other';

export type StorageType = {
  readonly label: StorageTypeLabel;
  readonly count: number;
  readonly bytes: number;
  /** Share of the used bytes, 0 to 100, for the bar segment. */
  readonly percent: number;
};

export type StorageDrive = {
  readonly driveId: string;
  readonly name: string;
  readonly files: number;
  readonly size: string;
};

export type StorageFile = {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
};

export type StorageView = {
  readonly tier: string;
  readonly quota: string;
  readonly used: string;
  readonly available: string;
  readonly usedBytes: number;
  readonly totalFiles: number;
  readonly limits: readonly { readonly label: string; readonly value: string }[];
  readonly types: readonly StorageType[];
  readonly drives: readonly StorageDrive[];
  readonly largest: readonly StorageFile[];
  readonly recent: readonly StorageFile[];
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const objects = (value: unknown): readonly Readonly<Record<string, unknown>>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

/** Bytes as the board writes them ("250MB", "2GB"), for limits the API sends in raw bytes. */
export const bytesLabel = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 1) return '0B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${Math.round((bytes / 1024 ** index) * 100) / 100}${units[index]}`;
};

/** A storage category as the bar groups it: PDFs, Images, Videos and everything else. */
const typeLabelOf = (category: string): StorageTypeLabel => {
  if (category === 'PDFs') return 'PDF';
  if (category === 'Images') return 'Images';
  if (category === 'Videos') return 'Video';
  return 'Other';
};

/** The bar's segments: the API's per-category totals folded into the four board labels, largest share first. */
export const typesOf = (breakdown: unknown, usedBytes: number): readonly StorageType[] => {
  if (!isRecord(breakdown)) return [];
  const totals = new Map<StorageTypeLabel, { count: number; bytes: number }>();
  for (const [category, value] of Object.entries(breakdown)) {
    if (!isRecord(value)) continue;
    const count = finite(value.count) ?? 0;
    const bytes = finite(value.totalSize) ?? 0;
    const label = typeLabelOf(category);
    const current = totals.get(label) ?? { count: 0, bytes: 0 };
    totals.set(label, { count: current.count + count, bytes: current.bytes + bytes });
  }
  return [...totals.entries()]
    .filter(([, total]) => total.count > 0)
    .map(([label, total]) => ({
      label,
      count: total.count,
      bytes: total.bytes,
      percent: usedBytes > 0 ? (total.bytes / usedBytes) * 100 : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);
};

const fileOf = (row: Readonly<Record<string, unknown>>, detail: (row: Readonly<Record<string, unknown>>) => string | null): StorageFile => ({
  id: text(row.id) ?? '',
  title: text(row.title) ?? 'Untitled file',
  detail: detail(row) ?? '',
});

const sizeOf = (row: Readonly<Record<string, unknown>>): string => text(row.formattedSize) ?? '';

const whenOf = (row: Readonly<Record<string, unknown>>): string | null => {
  const created = text(row.createdAt);
  if (created === null) return null;
  const date = new Date(created);
  return Number.isNaN(date.getTime()) ? null : formatDistanceToNow(date, { addSuffix: true });
};

/**
 * The storage screen's figures from the summary body; null for an error body or nothing loaded yet.
 * Every figure is the API's own, so nothing here is invented: sizes arrive formatted and the bar's
 * percentages are the only derived numbers.
 */
export const storageOf = (body: unknown): StorageView | null => {
  if (!isRecord(body) || !isRecord(body.quota)) return null;
  const quota = body.quota;
  const tier = isRecord(body.tierInfo) ? body.tierInfo : {};
  const usedBytes = finite(quota.usedBytes) ?? 0;
  const totalFiles = finite(body.totalFiles) ?? 0;
  const maxFileCount = finite(tier.maxFileCount) ?? 0;
  const maxFileSize = finite(tier.maxFileSize);
  const maxConcurrent = finite(tier.maxConcurrentUploads);

  return {
    tier: text(tier.name) ?? 'Free',
    quota: text(quota.formattedQuota) ?? '',
    used: text(quota.formattedUsed) ?? '',
    available: text(quota.formattedAvailable) ?? '',
    usedBytes,
    totalFiles,
    limits: [
      { label: 'Files', value: String(totalFiles) },
      ...(maxFileSize === null ? [] : [{ label: 'Max file size', value: bytesLabel(maxFileSize) }]),
      ...(maxConcurrent === null ? [] : [{ label: 'Concurrent uploads', value: String(maxConcurrent) }]),
      ...(maxFileCount > 0 ? [{ label: 'Max files', value: String(maxFileCount) }] : []),
    ],
    types: typesOf(body.fileTypeBreakdown, usedBytes),
    drives: objects(body.storageByDrive).map((drive) => ({
      driveId: text(drive.driveId) ?? '',
      name: text(drive.driveName) ?? 'Untitled drive',
      files: finite(drive.fileCount) ?? 0,
      size: sizeOf(drive),
    })),
    largest: objects(body.largestFiles).map((row) => fileOf(row, sizeOf)),
    recent: objects(body.recentFiles).map((row) =>
      fileOf(row, (file) => {
        const when = whenOf(file);
        const size = sizeOf(file);
        return when === null ? size : `${size} · ${when}`;
      }),
    ),
  };
};
