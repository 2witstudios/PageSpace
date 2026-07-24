import { getStorageConfigFromSubscription, getStorageTierFromSubscription, STORAGE_TIERS, type SubscriptionTier } from './subscription-utils';
import { storageRepository, type DrizzleTx } from './storage-repository';
import { countLiveUploadsForUser } from './pending-uploads';
import { canStartUpload } from './pending-uploads-core';

// Re-exported for existing consumers; the canonical table lives in subscription-utils.
export { STORAGE_TIERS };

export interface StorageQuota {
  userId: string;
  quotaBytes: number;
  usedBytes: number;
  availableBytes: number;
  utilizationPercent: number;
  tier: 'free' | 'pro' | 'founder' | 'business';
  warningLevel: 'none' | 'warning' | 'critical';
}

// Map subscription tiers to storage tiers (deprecated - use subscription-utils instead)
export function mapSubscriptionToStorageTier(subscriptionTier: 'free' | 'pro' | 'founder' | 'business'): 'free' | 'pro' | 'founder' | 'business' {
  const tier = getStorageTierFromSubscription(subscriptionTier);
  return tier; // Return tier directly since we've removed enterprise
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
 * Check if user has available upload slots.
 *
 * #2154: derived from live (unexpired) `pending_uploads` rows rather than the
 * old `users.activeUploads` counter, which leaked +1 forever when a process
 * died between presign and complete.
 */
export async function checkConcurrentUploads(userId: string): Promise<boolean> {
  const user = await storageRepository.findUserForStorage(userId);

  if (!user) return false;

  const subscriptionTier = (user.subscriptionTier || 'free') as SubscriptionTier;
  const storageConfig = getStorageConfigFromSubscription(subscriptionTier);

  const liveUploads = await countLiveUploadsForUser(userId);
  return canStartUpload(liveUploads, storageConfig.maxConcurrentUploads);
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

export interface StorageDriftInput {
  /** The users.storageUsedBytes cache (REAL column — may be fractional). */
  materializedBytes: number;
  /** SUM(files.sizeBytes) over the user's files rows — the source of truth. */
  derivedBytes: number;
}

export interface StorageDriftResult {
  /** materialized − derived, as integer bytes. */
  driftBytes: number;
  /** True when |drift| exceeds the tolerance — the cache needs a rewrite. */
  flagged: boolean;
}

/**
 * #2155 — compare the materialized storage counter against what the `files`
 * rows imply (pure; modeled on computeBalanceDrift in the credit service).
 * Between a delete and the orphan-reaper cron the two legitimately disagree,
 * so a small tolerance keeps the reconcile from thrashing on in-flight state;
 * a flag means "rewrite the cache from the rows", not "data corruption".
 */
export function computeStorageDrift(input: StorageDriftInput, toleranceBytes: number): StorageDriftResult {
  const driftBytes = Math.round(input.materializedBytes) - Math.round(input.derivedBytes);
  const flagged = Math.abs(driftBytes) > Math.max(0, Math.round(toleranceBytes));
  return { driftBytes, flagged };
}

/** Matches reconcileStorageUsage's historical 1-byte float tolerance. */
const STORAGE_DRIFT_TOLERANCE_BYTES = 1;

export interface StorageReconcileCorrection {
  userId: string;
  previousUsage: number;
  actualUsage: number;
  driftBytes: number;
}

/**
 * #2155 — the scheduled reconcile behind api/cron/reconcile-storage. Finds
 * every user whose storageUsedBytes cache has drifted from SUM(files.sizeBytes)
 * and rewrites the cache from the rows, logging a 'reconcile' storage event per
 * correction. Per-user failures are isolated so one bad account can't block
 * the sweep; callers alert on a non-empty `corrected`/`failed`.
 */
export async function reconcileAllStorageUsage(): Promise<{
  corrected: StorageReconcileCorrection[];
  failed: string[];
}> {
  const candidates = await storageRepository.findStorageDriftCandidates(STORAGE_DRIFT_TOLERANCE_BYTES);

  const corrected: StorageReconcileCorrection[] = [];
  const failed: string[] = [];

  for (const candidate of candidates) {
    const drift = computeStorageDrift(candidate, STORAGE_DRIFT_TOLERANCE_BYTES);
    if (!drift.flagged) continue;

    const actualUsage = Math.round(candidate.derivedBytes);
    const previousUsage = Math.round(candidate.materializedBytes);

    try {
      await storageRepository.runTransaction(async (tx) => {
        await storageRepository.setUserStorageInTx(tx, candidate.userId, actualUsage);
        await storageRepository.insertStorageEvent(tx, {
          userId: candidate.userId,
          eventType: 'reconcile',
          sizeDelta: actualUsage - previousUsage,
          totalSizeAfter: actualUsage,
          metadata: { previousUsage, actualUsage, difference: actualUsage - previousUsage, source: 'cron' },
        });
      });
      corrected.push({ userId: candidate.userId, previousUsage, actualUsage, driftBytes: drift.driftBytes });
    } catch {
      failed.push(candidate.userId);
    }
  }

  return { corrected, failed };
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

/**
 * @deprecated - Removed: Use subscription tier changes instead
 */
export async function changeUserTier(): Promise<void> {
  throw new Error('changeUserTier has been removed - storage tiers are computed from subscription tiers automatically');
}

/**
 * @deprecated - Removed: Storage tiers are computed dynamically
 */
export async function updateStorageTierFromSubscription(): Promise<void> {
  throw new Error('updateStorageTierFromSubscription has been removed - storage tiers are computed dynamically');
}
