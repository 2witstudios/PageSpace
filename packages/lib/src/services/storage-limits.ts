import { getStorageConfigFromSubscription, STORAGE_TIERS, type SubscriptionTier } from './subscription-utils';
import { storageRepository, type DrizzleTx } from './storage-repository';
import { reserveUploadSlot } from './pending-uploads';
import { getAdvisoryLockPool } from '@pagespace/db/db';
import { withAdvisoryLock, type AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import type { BillingPayer } from '../billing/sandbox-payer';

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

/**
 * An organization's storage quota (WAL-9, O-9). Every org is on Business (SEAT-8), and its
 * usage is DERIVED — SUM(files.sizeBytes) over files in the org's drives — rather than cached,
 * so a drive moving in or out changes the org's usage with no counter to keep in step.
 */
export interface OrgStorageQuota extends Omit<StorageQuota, 'userId'> {
  orgId: string;
}

/** The quota an upload is checked against: the uploader's, or the drive's org's. */
export type AnyStorageQuota = StorageQuota | OrgStorageQuota;

export interface StorageCheckResult<Q extends AnyStorageQuota = StorageQuota> {
  allowed: boolean;
  reason?: string;
  quota?: Q;
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

  const bytes = decideStorageBytes({ quota, fileSize });
  if (!bytes.allowed) return bytes;

  // Counted only once the byte checks pass: the count is the expensive read.
  return decideFileCount({ quota, fileCount: await getUserFileCount(userId) });
}

/**
 * The byte half of a quota check (pure): the tier's per-file limit, then the bytes left.
 * One rule for a person's quota and an org's.
 */
export function decideStorageBytes<Q extends AnyStorageQuota>(input: { quota: Q; fileSize: number }): StorageCheckResult<Q> {
  const { quota, fileSize } = input;
  const tierConfig = STORAGE_TIERS[quota.tier];
  if (fileSize > tierConfig.maxFileSize) {
    return {
      allowed: false,
      reason: `File exceeds ${quota.tier} tier limit of ${formatBytes(tierConfig.maxFileSize)}`,
      quota,
      requiredBytes: fileSize
    };
  }
  if (fileSize > quota.availableBytes) {
    return {
      allowed: false,
      reason: `Insufficient storage: need ${formatBytes(fileSize)}, have ${formatBytes(quota.availableBytes)} available`,
      quota,
      requiredBytes: fileSize
    };
  }
  return { allowed: true, quota };
}

/** The file-count half of a quota check (pure). A tier limit of 0 means unlimited. */
export function decideFileCount<Q extends AnyStorageQuota>(input: { quota: Q; fileCount: number }): StorageCheckResult<Q> {
  const { quota, fileCount } = input;
  const tierConfig = STORAGE_TIERS[quota.tier];
  if (tierConfig.maxFileCount > 0 && fileCount >= tierConfig.maxFileCount) {
    return {
      allowed: false,
      reason: `File count limit reached (${tierConfig.maxFileCount} files max for ${quota.tier} tier)`,
      quota
    };
  }
  return { allowed: true, quota };
}

/**
 * An org's quota over its derived usage (pure). Every org is on Business (SEAT-8), so the
 * Business storage limits apply; a lapsed org's restrictions are SEAT-9's, not storage's.
 */
export function buildOrgStorageQuota(input: { orgId: string; usedBytes: number }): OrgStorageQuota {
  const storageConfig = getStorageConfigFromSubscription('business');
  const quotaBytes = storageConfig.quotaBytes;
  const usedBytes = toByteCount(input.usedBytes);
  const utilizationPercent = quotaBytes > 0 ? (usedBytes / quotaBytes) * 100 : 0;
  return {
    orgId: input.orgId,
    quotaBytes,
    usedBytes,
    availableBytes: Math.max(0, quotaBytes - usedBytes),
    utilizationPercent,
    tier: storageConfig.tier,
    warningLevel: getWarningLevel(utilizationPercent),
  };
}

/**
 * The org's storage quota over its derived usage (WAL-9): SUM(files.sizeBytes) across its drives.
 */
export async function getOrgStorageQuota(orgId: string): Promise<OrgStorageQuota> {
  return buildOrgStorageQuota({ orgId, usedBytes: await storageRepository.sumOrgFileBytes(orgId) });
}

/**
 * drives.orgId for each of `driveIds`, for callers that attribute many files at once (the
 * orphan reaper). A drive that no longer exists maps to null: its files rows cascaded with it.
 */
export async function findDriveOrgIds(driveIds: ReadonlyArray<string>): Promise<Map<string, string | null>> {
  return storageRepository.findDriveOrgIds([...new Set(driveIds)]);
}

/** FILE pages across the org's drives: the org's file count (WAL-9). */
export async function getOrgFileCount(orgId: string): Promise<number> {
  const driveIds = await storageRepository.findOrgDriveIds(orgId);
  if (driveIds.length === 0) return 0;
  return storageRepository.countFiles(driveIds);
}

/**
 * Who an upload into `driveId` bills (WAL-9, O-9): the drive's org when it has one, else the
 * uploader. A drive-less upload (a DM attachment) and a drive that cannot be found bill the
 * uploader, which is what every upload did before orgs.
 */
export async function resolveUploadPayer(userId: string, driveId: string | null | undefined): Promise<BillingPayer> {
  const orgId = driveId ? await storageRepository.findDriveOrgId(driveId) : null;
  return storagePayerForFile({ createdBy: userId, driveOrgId: orgId ?? null }) ?? { kind: 'user', userId };
}

/**
 * Who an upload into a drive bills, and the quota it is checked against, read ONCE (WAL-9).
 * A caller that needs both the quota (its tier) and the check resolves this once and passes it
 * to `checkUploadQuotaTarget`, so the org's derived usage (a SUM over every file in the org) is
 * read once per request (#2719 review P2-2). Deliberately uncached: an undercounted usage lets
 * an org exceed its quota.
 */
export interface UploadQuotaTarget {
  payer: BillingPayer;
  quota: AnyStorageQuota;
}

/**
 * The payer and quota for an upload into `driveId`: the org's for an org drive, the uploader's
 * otherwise. An upload into an org drive never reads the uploader's personal quota. Null when a
 * personally billed uploader does not exist.
 */
export async function resolveUploadQuotaTarget(
  userId: string,
  driveId: string | null | undefined,
): Promise<UploadQuotaTarget | null> {
  const payer = await resolveUploadPayer(userId, driveId);
  if (payer.kind === 'org') return { payer, quota: await getOrgStorageQuota(payer.orgId) };
  const quota = await getUserStorageQuota(userId);
  return quota ? { payer, quota } : null;
}

/**
 * The upload quota check against an already-resolved target: the tier's per-file limit, the
 * bytes left, then the payer's file count. Re-reads neither the payer nor the usage.
 */
export async function checkUploadQuotaTarget(
  target: UploadQuotaTarget | null,
  fileSize: number,
): Promise<StorageCheckResult<AnyStorageQuota>> {
  if (!target) return { allowed: false, reason: 'User not found' };
  const { payer, quota } = target;
  const bytes = decideStorageBytes({ quota, fileSize });
  if (!bytes.allowed) return bytes;

  // Counted only once the byte checks pass: the count is the expensive read.
  const fileCount = payer.kind === 'org' ? await getOrgFileCount(payer.orgId) : await getUserFileCount(payer.userId);
  return decideFileCount({ quota, fileCount });
}

/**
 * The quota an upload into `driveId` is checked against: the org's for an org drive, the
 * uploader's otherwise (WAL-9). Null when the uploader does not exist.
 */
export async function getStorageQuotaForDrive(
  userId: string,
  driveId: string | null | undefined,
): Promise<AnyStorageQuota | null> {
  return (await resolveUploadQuotaTarget(userId, driveId))?.quota ?? null;
}

/**
 * The upload quota check for an upload into `driveId` (WAL-9): an org drive checks the org's
 * bytes, per-file size and file count; anything else checks the uploader's.
 */
export async function checkStorageQuotaForDrive(
  userId: string,
  driveId: string | null | undefined,
  fileSize: number,
): Promise<StorageCheckResult<AnyStorageQuota>> {
  return checkUploadQuotaTarget(await resolveUploadQuotaTarget(userId, driveId), fileSize);
}

/**
 * Charge the first physical store of `deltaBytes` uploaded into `driveId` (WAL-9, O-9). The
 * uploader's personal counter moves only when the upload bills them; an org drive's usage is
 * derived from its files rows, so an org-billed store writes no counter at all. Returns who the
 * bytes bill.
 */
export async function chargeStorageForStore(
  userId: string,
  driveId: string | null | undefined,
  deltaBytes: number,
  context: { pageId?: string; eventType?: 'upload' | 'delete' | 'update' | 'reconcile' },
): Promise<BillingPayer> {
  const payer = await resolveUploadPayer(userId, driveId);
  if (payer.kind === 'user') {
    await updateStorageUsage(userId, deltaBytes, { ...context, driveId: driveId ?? undefined });
  }
  return payer;
}

/** What a drive move did to stored-byte attribution (O-9). */
export interface StorageReattributionResult {
  status: 'applied';
  direction: DriveMoveDirection;
  /** Bytes whose attribution moved between uploaders' personal quotas and the org. */
  movedBytes: number;
  deltas: StorageReattributionDelta[];
}

/**
 * O-9 (D-OW-9): re-attribute a moving drive's stored bytes INSIDE the move's transaction, so
 * drives.orgId and every uploader's counter change together or not at all. Moving in takes each
 * uploader's bytes in the drive off their personal quota; moving out puts them back. The org's
 * usage is derived from its drives, so it follows drives.orgId with no write. One
 * 'reattribute' storage event per uploader, inserted in chunks.
 */
export async function reattributeDriveStorageInTx(
  tx: DrizzleTx,
  input: { driveId: string; orgId: string; direction: DriveMoveDirection },
): Promise<StorageReattributionResult> {
  const files = await storageRepository.findDriveFileBytesInTx(tx, input.driveId);
  const deltas = computeMoveReattribution({ files, direction: input.direction });
  const events: Parameters<typeof storageRepository.insertStorageEventsInTx>[1] = [];
  for (const { userId, deltaBytes } of deltas) {
    const { newUsage } = await storageRepository.updateStorageInTx(tx, userId, deltaBytes);
    events.push({
      userId,
      eventType: 'reattribute',
      sizeDelta: deltaBytes,
      totalSizeAfter: newUsage,
      metadata: { driveId: input.driveId, orgId: input.orgId, direction: input.direction },
    });
  }
  await storageRepository.insertStorageEventsInTx(tx, events);
  return {
    status: 'applied',
    direction: input.direction,
    movedBytes: deltas.reduce((sum, d) => sum + Math.abs(d.deltaBytes), 0),
    deltas,
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

/**
 * WAL-9, O-9 (D-OW-9) — who a stored file's bytes bill (pure). A file in an org drive
 * attributes to the drive and bills the org, whoever uploaded it; any other file bills its
 * uploader (files.createdBy), or nobody once that user is gone. `driveOrgId` is the orgId of
 * the file's drive (files.driveId) — null for a personal drive or a drive-less attachment.
 *
 * The attribution follows files.driveId: storage is content-addressed, so a blob has ONE files
 * row, and its bytes stay where they were first stored even when a page in another drive links
 * the same hash.
 */
export function storagePayerForFile(input: { createdBy: string | null; driveOrgId: string | null }): BillingPayer | null {
  if (input.driveOrgId !== null) return { kind: 'org', orgId: input.driveOrgId };
  if (input.createdBy) return { kind: 'user', userId: input.createdBy };
  return null;
}

export type DriveMoveDirection = 'into-org' | 'out-of-org';

export interface StorageReattributionDelta {
  userId: string;
  /** Negative on a move in (the bytes leave the personal quota), positive on a move out. */
  deltaBytes: number;
}

/**
 * O-9 (D-OW-9) — re-attribute a drive's stored bytes when it moves into or out of an org
 * (pure). Each uploader was charged, on their personal quota, exactly the bytes of the files
 * rows they created in the drive while it was personal; moving in takes exactly those bytes off
 * their quota (the org's usage is derived from its drives, so it rises by the same total with
 * no write), and moving out puts exactly them back. A move in then out nets zero for every
 * uploader: nothing is double-counted or orphaned. Files whose uploader was deleted were never
 * charged to anyone, so they move nobody's counter.
 *
 * Sorted by userId so every move updates users rows in one order (no lock cycle between two
 * concurrent moves that share uploaders). Integer bytes only.
 */
export function computeMoveReattribution(input: {
  files: ReadonlyArray<{ createdBy: string | null; sizeBytes: number | string | null }>;
  direction: DriveMoveDirection;
}): StorageReattributionDelta[] {
  const byUser = new Map<string, number>();
  for (const file of input.files) {
    if (!file.createdBy) continue;
    byUser.set(file.createdBy, (byUser.get(file.createdBy) ?? 0) + toByteCount(file.sizeBytes));
  }
  const sign = input.direction === 'into-org' ? -1 : 1;
  return [...byUser.entries()]
    .filter(([, bytes]) => bytes > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([userId, bytes]) => ({ userId, deltaBytes: sign * bytes }));
}

export interface UnlinkCreditInput {
  /** files.createdBy — the uploader who was charged on first physical store. */
  createdBy: string | null;
  /**
   * The orgId of the file's drive at reap time. An org drive's bytes bill the org, whose usage
   * is derived from the rows themselves, so no personal quota is credited (WAL-9).
   */
  driveOrgId: string | null;
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
  const payer = storagePayerForFile({ createdBy: input.createdBy, driveOrgId: input.driveOrgId });
  if (payer?.kind !== 'user') return null;
  const bytes = toByteCount(input.sizeBytes);
  if (bytes === 0) return null;
  return { userId: payer.userId, deltaBytes: -bytes };
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

  // #2225 review (Codex round 5) — upload/complete inserts the `files` row and
  // calls `updateStorageUsage` as two separate, non-atomic steps. If the
  // insert lands between the two reads above but its own storageUsedBytes
  // update hasn't yet, derivedUsage already includes it while quota.usedBytes
  // doesn't — applying that as drift here would double-count it once the
  // upload's own pending update lands. Skip correcting (treat as a no-op this
  // call) when this user's most recent files row is still within the same
  // cooldown window the cron sweep uses for the identical race.
  const lastFileCreatedAt = await storageRepository.findLastFileCreatedAtForUser(userId);
  const withinCooldown = lastFileCreatedAt !== null
    && Date.now() - lastFileCreatedAt.getTime() < STORAGE_DRIFT_COOLDOWN_SECONDS * 1000;

  // Update if there's a discrepancy
  if (!withinCooldown && Math.abs(difference) > 1) { // Allow 1 byte tolerance for floating point
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
