import { getStorageConfigFromSubscription, STORAGE_TIERS, type SubscriptionTier } from './subscription-utils';
import { storageRepository, type DrizzleTx } from './storage-repository';

// Re-exported for existing consumers; the canonical table lives in subscription-utils.
export { STORAGE_TIERS };

export interface StorageQuota {
  userId: string;
  quotaBytes: number;
  usedBytes: number;
  availableBytes: number;
  utilizationPercent: number;
  tier: SubscriptionTier;
  warningLevel: 'none' | 'warning' | 'critical';
}

export interface StorageCheckResult {
  allowed: boolean;
  reason?: string;
  quota?: StorageQuota;
  requiredBytes?: number;
}

/**
 * Get user's current storage quota and usage
 * Computes quota from subscription tier for consistency
 */
export async function getUserStorageQuota(userId: string): Promise<StorageQuota | null> {
  const user = await storageRepository.findUserForStorage(userId);

  if (!user) return null;

  // Compute storage config from subscription tier
  const subscriptionTier = (user.subscriptionTier || 'free') as SubscriptionTier;
  const storageConfig = getStorageConfigFromSubscription(subscriptionTier);

  const quotaBytes = storageConfig.quotaBytes;
  const usedBytes = user.storageUsedBytes || 0;
  const availableBytes = Math.max(0, quotaBytes - usedBytes);
  const utilizationPercent = quotaBytes > 0 ? (usedBytes / quotaBytes) * 100 : 0;

  return {
    userId: user.id,
    quotaBytes,
    usedBytes,
    availableBytes,
    utilizationPercent,
    tier: storageConfig.tier,
    warningLevel: getWarningLevel(utilizationPercent)
  };
}

/**
 * Check if user can upload a file of given size
 * This is the main validation function for uploads
 */
export async function checkStorageQuota(
  userId: string,
  fileSize: number
): Promise<StorageCheckResult> {
  // Get user's current quota
  const quota = await getUserStorageQuota(userId);

  if (!quota) {
    return {
      allowed: false,
      reason: 'User not found'
    };
  }

  // Check tier file size limit
  const tierConfig = STORAGE_TIERS[quota.tier];
  if (fileSize > tierConfig.maxFileSize) {
    return {
      allowed: false,
      reason: `File exceeds ${quota.tier} tier limit of ${formatBytes(tierConfig.maxFileSize)}`,
      quota,
      requiredBytes: fileSize
    };
  }

  // Check available storage
  if (fileSize > quota.availableBytes) {
    return {
      allowed: false,
      reason: `Insufficient storage: need ${formatBytes(fileSize)}, have ${formatBytes(quota.availableBytes)} available`,
      quota,
      requiredBytes: fileSize
    };
  }

  // Check file count limit
  const fileCount = await getUserFileCount(userId);
  if (tierConfig.maxFileCount > 0 && fileCount >= tierConfig.maxFileCount) {
    return {
      allowed: false,
      reason: `File count limit reached (${tierConfig.maxFileCount} files max for ${quota.tier} tier)`,
      quota
    };
  }

  return {
    allowed: true,
    quota
  };
}

/**
 * Check if user has available upload slots
 */
export async function checkConcurrentUploads(userId: string): Promise<boolean> {
  const user = await storageRepository.findUserForUploads(userId);

  if (!user) return false;

  const subscriptionTier = (user.subscriptionTier || 'free') as SubscriptionTier;
  const storageConfig = getStorageConfigFromSubscription(subscriptionTier);

  return (user.activeUploads || 0) < storageConfig.maxConcurrentUploads;
}

/**
 * Update user's storage usage atomically
 * Uses database transaction to prevent race conditions
 * Can accept an existing transaction to participate in larger atomic operations
 */
export async function updateStorageUsage(
  userId: string,
  deltaBytes: number,
  context?: {
    pageId?: string;
    driveId?: string;
    eventType?: 'upload' | 'delete' | 'update' | 'reconcile';
  },
  existingTx?: DrizzleTx
): Promise<void> {
  const executeUpdate = async (tx: DrizzleTx) => {
    const { newUsage } = await storageRepository.updateStorageInTx(tx, userId, deltaBytes);

    // Log storage event for audit trail
    if (context) {
      await storageRepository.insertStorageEvent(tx, {
        userId,
        pageId: context.pageId || null,
        eventType: context.eventType || 'update',
        sizeDelta: deltaBytes,
        totalSizeAfter: newUsage,
        metadata: context.driveId ? { driveId: context.driveId } : null,
      });
    }
  };

  // Use existing transaction or create a new one
  if (existingTx) {
    await executeUpdate(existingTx);
  } else {
    await storageRepository.runTransaction(async (tx) => {
      await executeUpdate(tx);
    });
  }
}

/**
 * Increment/decrement active upload count
 */
export async function updateActiveUploads(
  userId: string,
  delta: number
): Promise<void> {
  await storageRepository.updateActiveUploads(userId, delta);
}

/**
 * Coerce a possibly-BIGINT-as-string / null / NaN byte value to a non-negative
 * integer. Postgres returns BIGINT columns (e.g. files.sizeBytes) as strings.
 */
export function toByteCount(value: number | string | null | undefined): number {
  const n = typeof value === 'string' ? Number(value) : (value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * H4 — sum a reconcile population (pure). The charge path bills the UPLOADER and
 * a `files` row is created (createdBy = uploader) on the first physical store of
 * every page-file AND attachment. So the population that reconcile must re-sum to
 * match the charge basis is exactly the user's `files` rows — across drives, and
 * including trashed-but-not-yet-purged ones (the `files` row survives until the
 * orphan reaper deletes it). This pure summation is integer-safe and ignores
 * null/garbage so a single bad row can't poison the total.
 */
export function sumStorageBytes(
  rows: ReadonlyArray<{ sizeBytes: number | string | null }>,
): number {
  let total = 0;
  for (const row of rows) total += toByteCount(row.sizeBytes);
  return total;
}

/**
 * M8 (charge side) — only charge storage on the FIRST physical store of a blob.
 *
 * Storage is content-addressed: the second+ uploader of identical bytes hits
 * `files` ON CONFLICT DO NOTHING, so no new bytes are stored and `files.createdBy`
 * stays the first uploader. Charging every /complete (the old behaviour) meant N
 * charges but the reaper only ever credits `createdBy` once — a permanent quota
 * leak for the non-first uploaders. Charging only when the row was newly inserted
 * keeps the charge symmetric with the single credit at unlink.
 */
export function shouldChargeForStore(fileRowNewlyInserted: boolean): boolean {
  return fileRowNewlyInserted;
}

export interface UnlinkCreditInput {
  /** files.createdBy — the uploader who was charged on first physical store. */
  createdBy: string | null;
  sizeBytes: number | string | null;
  /** Whether THIS reap call actually deleted the row (race-safe credit gate). */
  deletedByThisCall: boolean;
  /** False for DB-only stubs whose bytes were never persisted (no credit owed). */
  hadPhysicalBlob: boolean;
}

export interface StorageCredit {
  userId: string;
  /** Negative byte delta to apply to the uploader's usage. */
  deltaBytes: number;
}

/**
 * M8 (credit side) — compute the storage credit owed when a content-addressed
 * blob is unlinked/reaped (pure). Mirrors {@link shouldChargeForStore}: exactly
 * one credit, to the uploader who paid the single first-store charge, and only
 * when this call truly removed the row and real bytes existed. Returns null when
 * no credit is owed. Integer bytes only.
 */
export function computeStorageCreditOnUnlink(input: UnlinkCreditInput): StorageCredit | null {
  if (!input.deletedByThisCall) return null;
  if (!input.hadPhysicalBlob) return null;
  if (!input.createdBy) return null;
  const bytes = toByteCount(input.sizeBytes);
  if (bytes === 0) return null;
  return { userId: input.createdBy, deltaBytes: -bytes };
}

/**
 * Calculate actual storage usage from database
 * Used for reconciliation and verification
 *
 * H4: sums the SAME population the charge path bills — the user's `files` rows
 * (createdBy = userId) across every drive, including trashed-but-unpurged files.
 * The old basis (FILE pages in drives the user OWNS, non-trashed only) diverged
 * from charging: it missed channel/DM attachments, misattributed cross-drive
 * uploads, and excluded trashed files — so `?reconcile=true` could be abused to
 * reset usage downward (self-serve quota wipe).
 */
export async function calculateActualStorageUsage(userId: string): Promise<number> {
  const rows = await storageRepository.findFilesByCreator(userId);
  return sumStorageBytes(rows);
}

/**
 * H3: whether the caller already legitimately references a content hash (so the
 * dedup fast-path / linking a pre-existing object is safe for them). Delegates to
 * the repository; the routes consume this through the service layer.
 */
export async function userReferencesContentHash(
  userId: string,
  contentHash: string,
  driveId: string,
): Promise<boolean> {
  return storageRepository.userReferencesContentHash(userId, contentHash, driveId);
}

/**
 * Get count of user's files
 */
export async function getUserFileCount(userId: string): Promise<number> {
  const driveIds = await storageRepository.findUserDriveIds(userId);
  if (driveIds.length === 0) return 0;
  return storageRepository.countFiles(driveIds);
}

/**
 * Reconcile stored usage with actual usage
 * Should be run periodically to fix any drift
 */
export async function reconcileStorageUsage(userId: string): Promise<{
  previousUsage: number;
  actualUsage: number;
  difference: number;
}> {
  const quota = await getUserStorageQuota(userId);
  if (!quota) {
    throw new Error('User not found');
  }

  const actualUsage = await calculateActualStorageUsage(userId);
  const difference = actualUsage - quota.usedBytes;

  // Update if there's a discrepancy
  if (Math.abs(difference) > 1) { // Allow 1 byte tolerance for floating point
    await storageRepository.runTransaction(async (tx) => {
      await storageRepository.setUserStorageInTx(tx, userId, actualUsage);

      await storageRepository.insertStorageEvent(tx, {
        userId,
        eventType: 'reconcile',
        sizeDelta: difference,
        totalSizeAfter: actualUsage,
        metadata: { previousUsage: quota.usedBytes, actualUsage, difference },
      });
    });
  }

  return {
    previousUsage: quota.usedBytes,
    actualUsage,
    difference
  };
}

/**
 * Get storage warning level based on usage percentage
 */
function getWarningLevel(percent: number): 'none' | 'warning' | 'critical' {
  if (percent >= 95) return 'critical';
  if (percent >= 80) return 'warning';
  return 'none';
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${Math.round(bytes / Math.pow(1024, i) * 100) / 100} ${sizes[i]}`;
}

/**
 * Parse human-readable size to bytes
 */
export function parseBytes(size: string): number {
  // Defensive check for undefined/null input
  if (!size || typeof size !== 'string') {
    throw new Error(`Invalid size parameter: expected string, got ${typeof size}`);
  }

  const units: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024
  };

  const match = size.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?B)$/i);
  if (!match) throw new Error(`Invalid size format: "${size}"`);

  const [, value, unit] = match;
  return Math.floor(parseFloat(value) * (units[unit.toUpperCase()] || 1));
}
