import { getStorageConfigFromSubscription, STORAGE_TIERS, type SubscriptionTier } from './subscription-utils';
import { storageRepository, type DrizzleTx } from './storage-repository';
import { reserveUploadSlot } from './pending-uploads';
import { getAdvisoryLockPool } from '@pagespace/db/db';
import { withAdvisoryLock, type AdvisoryLockPool } from '@pagespace/db/advisory-lock';

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
 * Atomically check the user's live-upload count against their tier's
 * concurrency limit AND reserve the slot (insert the `pending_uploads` row)
 * in one step — the presign routes' cross-process concurrency gate (#2154).
 *
 * #2225 review: a separate "check the count" call followed later by a
 * separate "insert the row" call is NOT safe under concurrency — two presigns
 * for the same user landing on different web replicas can both read the same
 * live count before either inserts, both pass, and both reserve, exceeding
 * the tier limit by however many requests race. `reserveUploadSlot` closes
 * that gap with a single transaction serialized per-user (see
 * `pendingUploadsRepository.reserveIfUnderLimit`).
 *
 * Derived from live (unexpired) `pending_uploads` rows rather than the old
 * `users.activeUploads` counter, which leaked +1 forever when a process died
 * between presign and complete.
 */
export async function reserveConcurrentUploadSlot(
  jobId: string,
  userId: string,
  fileSize: number,
): Promise<boolean> {
  const user = await storageRepository.findUserForStorage(userId);
  if (!user) return false;

  const subscriptionTier = (user.subscriptionTier || 'free') as SubscriptionTier;
  const storageConfig = getStorageConfigFromSubscription(subscriptionTier);

  return reserveUploadSlot(jobId, userId, fileSize, storageConfig.maxConcurrentUploads);
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
 * Reconcile stored usage with actual usage. Should be run periodically to fix
 * any drift.
 *
 * Applies the correction as a DELTA (via the same atomic `updateStorageInTx`
 * the charge/credit paths use), not an absolute overwrite. `actualUsage` and
 * `difference` are computed from a read taken before the correction runs, so
 * a concurrent upload/delete can land its own delta in between; overwriting
 * the counter with a stale absolute total would silently swallow that
 * concurrent write. A delta commutes with concurrent deltas instead — it
 * corrects the exact drift measured, whatever the counter's value is by the
 * time the correction transaction actually runs. `actualUsage` in the return
 * value reflects the counter's value immediately after the correction, which
 * is the source of truth if a concurrent write did land.
 *
 * Unlocked — callers MUST serialize invocations for the same user (see the
 * exported `reconcileStorageUsage`, which wraps this in the same advisory
 * lock as the scheduled sweep). Two unserialized concurrent calls would each
 * read the same drift and each apply the correction delta once, double
 * counting it exactly like two overlapping cron ticks would (#2225 review).
 */
async function reconcileStorageUsageUnlocked(userId: string): Promise<{
  previousUsage: number;
  actualUsage: number;
  difference: number;
}> {
  const quota = await getUserStorageQuota(userId);
  if (!quota) {
    throw new Error('User not found');
  }

  const derivedUsage = await calculateActualStorageUsage(userId);
  const difference = derivedUsage - quota.usedBytes;

  let actualUsage = quota.usedBytes;

  // Update if there's a discrepancy
  if (Math.abs(difference) > 1) { // Allow 1 byte tolerance for floating point
    actualUsage = await storageRepository.runTransaction(async (tx) => {
      const { newUsage } = await storageRepository.updateStorageInTx(tx, userId, difference);

      await storageRepository.insertStorageEvent(tx, {
        userId,
        eventType: 'reconcile',
        sizeDelta: difference,
        totalSizeAfter: newUsage,
        metadata: { previousUsage: quota.usedBytes, derivedUsage, difference },
      });

      return newUsage;
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

/**
 * #2225 review — skip a user whose most recent `files` row is younger than
 * this, so upload/complete's separate (deliberately non-atomic) files-row
 * insert + storageUsedBytes update has time to fully land before this cron
 * ever looks at that user. See findStorageDriftCandidates's doc for the race
 * this closes. Generous relative to the actual window (a page-enqueue network
 * call plus a DB write, normally milliseconds) and tiny relative to the
 * 15-minute cron cadence, so it doesn't meaningfully delay real drift fixes.
 */
const STORAGE_DRIFT_COOLDOWN_SECONDS = 300;

export interface StorageReconcileCorrection {
  userId: string;
  previousUsage: number;
  actualUsage: number;
  driftBytes: number;
}

/**
 * #2155 — the scheduled reconcile behind api/cron/reconcile-storage. Finds
 * every user whose storageUsedBytes cache has drifted from SUM(files.sizeBytes)
 * and corrects it, logging a 'reconcile' storage event per correction.
 *
 * The correction is applied as a DELTA (`updateStorageInTx`, the same atomic
 * increment the charge/credit paths use), not an absolute overwrite. This
 * cron runs every 15 minutes across every user; `findStorageDriftCandidates`
 * takes one snapshot read, and a concurrent upload/delete can land its own
 * delta on the SAME user between that snapshot and this correction's write.
 * Overwriting with the snapshot's absolute total would silently discard that
 * concurrent write. Applying the drift as a delta instead commutes with it —
 * whatever the counter's value is when the correction transaction actually
 * runs, adding the measured drift lands it on the correct total. Per-user
 * failures are isolated so one bad account can't block the sweep; callers
 * alert on a non-empty `corrected`/`failed`.
 */
export async function reconcileAllStorageUsage(): Promise<{
  corrected: StorageReconcileCorrection[];
  failed: string[];
}> {
  const candidates = await storageRepository.findStorageDriftCandidates(STORAGE_DRIFT_TOLERANCE_BYTES, STORAGE_DRIFT_COOLDOWN_SECONDS);

  const corrected: StorageReconcileCorrection[] = [];
  const failed: string[] = [];

  for (const candidate of candidates) {
    const drift = computeStorageDrift(candidate, STORAGE_DRIFT_TOLERANCE_BYTES);
    if (!drift.flagged) continue;

    const previousUsage = Math.round(candidate.materializedBytes);
    // Move the cache toward the derived total: driftBytes = materialized − derived,
    // so the correction that closes the gap is the negation of it.
    const correctionDelta = -drift.driftBytes;

    try {
      const actualUsage = await storageRepository.runTransaction(async (tx) => {
        const { newUsage } = await storageRepository.updateStorageInTx(tx, candidate.userId, correctionDelta);
        await storageRepository.insertStorageEvent(tx, {
          userId: candidate.userId,
          eventType: 'reconcile',
          sizeDelta: correctionDelta,
          totalSizeAfter: newUsage,
          metadata: { previousUsage, correctionDelta, actualUsage: newUsage, source: 'cron' },
        });
        return newUsage;
      });
      corrected.push({ userId: candidate.userId, previousUsage, actualUsage, driftBytes: drift.driftBytes });
    } catch {
      failed.push(candidate.userId);
    }
  }

  return { corrected, failed };
}

/**
 * Advisory-lock key serializing `reconcileAllStorageUsage` across EVERY
 * caller — the crontab has no overlap guard (unlike reconcile-machine-storage's
 * flock), and even a flock only protects one container's own scheduled ticks,
 * not a second container or a manual/API trigger. Two overlapping runs can
 * both read the same drift candidate (materialized=0, derived=100) and each
 * independently apply the same +100 correctionDelta, landing the counter at
 * 200 instead of 100 — the delta-based fix commutes with a DIFFERENT
 * concurrent write (a real charge/credit), but not with ANOTHER COPY OF
 * ITSELF applying the identical correction twice. Mirrors
 * reconcileMachineStorageSerialized in machine-storage-billing.ts.
 */
const RECONCILE_STORAGE_LOCK_KEY = 'reconcile-storage';

export type ReconcileAllStorageUsageRunResult =
  | { outcome: 'lock_busy' }
  | ({ outcome: 'reconciled' } & Awaited<ReturnType<typeof reconcileAllStorageUsage>>);

/**
 * Serializes `reconcileAllStorageUsage` with a Postgres session-level
 * advisory try-lock: a run that cannot acquire it (another run — any
 * process, any container — already holds it) is a clean no-op and never
 * reads or writes any drift candidate. This is what api/cron/reconcile-storage
 * actually calls.
 */
export async function reconcileAllStorageUsageSerialized(
  pgPool: AdvisoryLockPool = getAdvisoryLockPool(),
): Promise<ReconcileAllStorageUsageRunResult> {
  const locked = await withAdvisoryLock(pgPool, RECONCILE_STORAGE_LOCK_KEY, () =>
    reconcileAllStorageUsage(),
  );
  if (locked.outcome === 'lock_busy') {
    return { outcome: 'lock_busy' };
  }
  if (locked.outcome === 'connection_error') {
    throw locked.error;
  }
  return { outcome: 'reconciled', ...locked.result };
}

export type ReconcileStorageUsageRunResult =
  | { outcome: 'lock_busy' }
  | ({ outcome: 'reconciled' } & Awaited<ReturnType<typeof reconcileStorageUsageUnlocked>>);

/**
 * The admin-triggered single-user reconcile (api/storage/info's
 * `?reconcile=true`). Serializes against the SAME advisory lock as the
 * scheduled sweep (#2225 review) — two overlapping admin triggers, or an
 * admin trigger overlapping the cron, would otherwise both read the same
 * drift and each apply the correction delta once, double-counting it. A run
 * that loses the race is a clean no-op (returns `lock_busy`); the caller can
 * retry or just rely on the next scheduled sweep.
 */
export async function reconcileStorageUsage(
  userId: string,
  pgPool: AdvisoryLockPool = getAdvisoryLockPool(),
): Promise<ReconcileStorageUsageRunResult> {
  const locked = await withAdvisoryLock(pgPool, RECONCILE_STORAGE_LOCK_KEY, () =>
    reconcileStorageUsageUnlocked(userId),
  );
  if (locked.outcome === 'lock_busy') {
    return { outcome: 'lock_busy' };
  }
  if (locked.outcome === 'connection_error') {
    throw locked.error;
  }
  return { outcome: 'reconciled', ...locked.result };
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
