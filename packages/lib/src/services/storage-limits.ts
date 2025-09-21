import { db, users, pages, drives, storageEvents, eq, sql, and, isNull, inArray } from '@pagespace/db';
import { getStorageConfigFromSubscription, getStorageTierFromSubscription, type SubscriptionTier, type StorageTier } from './subscription-utils';

export interface StorageQuota {
  userId: string;
  quotaBytes: number;
  usedBytes: number;
  availableBytes: number;
  utilizationPercent: number;
  tier: StorageTier;
  warningLevel: 'none' | 'warning' | 'critical';
}

// Map subscription tiers to storage tiers (deprecated - use subscription-utils instead)
<<<<<<< Updated upstream
export function mapSubscriptionToStorageTier(subscriptionTier: SubscriptionTier): StorageTier {
  const tier = getStorageTierFromSubscription(subscriptionTier);
  return tier;
=======
export function mapSubscriptionToStorageTier(subscriptionTier: 'free' | 'pro' | 'business'): 'free' | 'pro' | 'enterprise' {
  return getStorageTierFromSubscription(subscriptionTier);
>>>>>>> Stashed changes
}

export interface StorageCheckResult {
  allowed: boolean;
  reason?: string;
  quota?: StorageQuota;
  requiredBytes?: number;
}

export const STORAGE_TIERS = {
  free: {
    name: 'Free',
    quotaBytes: 500 * 1024 * 1024,      // 500MB
    maxFileSize: 20 * 1024 * 1024,      // 20MB
    maxConcurrentUploads: 2,
    maxFileCount: 100,
    features: ['500MB storage', '20MB per file', 'Basic processing']
  },
  pro: {
    name: 'Pro',
    quotaBytes: 2 * 1024 * 1024 * 1024, // 2GB
    maxFileSize: 50 * 1024 * 1024,      // 50MB
    maxConcurrentUploads: 3,
    maxFileCount: 500,
    features: ['2GB storage', '50MB per file', 'Priority processing']
  },
  enterprise: {
    name: 'Business',
    quotaBytes: 50 * 1024 * 1024 * 1024, // 50GB
    maxFileSize: 100 * 1024 * 1024,      // 100MB
    maxConcurrentUploads: 10,
    maxFileCount: 5000,
    features: ['50GB storage', '100MB per file', 'Enterprise processing', 'Priority support']
  }
} as const;

/**
 * Get user's current storage quota and usage
 * Computes quota from subscription tier for consistency
 */
export async function getUserStorageQuota(userId: string): Promise<StorageQuota | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      id: true,
      storageUsedBytes: true,
      subscriptionTier: true
    }
  });

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

  // Get user's subscription tier for storage config
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { subscriptionTier: true }
  });

  if (!user) {
    return {
      allowed: false,
      reason: 'User not found'
    };
  }

  const subscriptionTier = (user.subscriptionTier || 'free') as SubscriptionTier;
  const tierConfig = getStorageConfigFromSubscription(subscriptionTier);

  // Check tier file size limit
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
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      activeUploads: true,
      subscriptionTier: true
    }
  });

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
  existingTx?: any // Transaction object from Drizzle
): Promise<void> {
  const executeUpdate = async (tx: any) => {
    // Lock user row and update storage
    const [updatedUser] = await tx
      .update(users)
      .set({
        storageUsedBytes: sql`GREATEST(0, COALESCE("storageUsedBytes", 0) + ${deltaBytes})`,
        lastStorageCalculated: new Date()
      })
      .where(eq(users.id, userId))
      .returning({
        newUsage: users.storageUsedBytes
      });

    // Log storage event for audit trail
    if (context) {
      await tx.insert(storageEvents).values({
        userId,
        pageId: context.pageId || null,
        eventType: context.eventType || 'update',
        sizeDelta: deltaBytes,
        totalSizeAfter: updatedUser.newUsage || 0,
        metadata: context.driveId ? { driveId: context.driveId } : null
      });
    }
  };

  // Use existing transaction or create a new one
  if (existingTx) {
    await executeUpdate(existingTx);
  } else {
    await db.transaction(async (tx) => {
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
  await db
    .update(users)
    .set({
      activeUploads: sql`GREATEST(0, COALESCE("activeUploads", 0) + ${delta})`
    })
    .where(eq(users.id, userId));
}

/**
 * Calculate actual storage usage from database
 * Used for reconciliation and verification
 */
export async function calculateActualStorageUsage(userId: string): Promise<number> {
  // Get all drives owned by user
  const userDrives = await db.query.drives.findMany({
    where: eq(drives.ownerId, userId),
    columns: { id: true }
  });

  if (userDrives.length === 0) return 0;

  const driveIds = userDrives.map(d => d.id);

  // Calculate total file size across all user's drives
  const result = await db
    .select({
      totalSize: sql<number>`COALESCE(SUM(CAST(${pages.fileSize} AS BIGINT)), 0)`
    })
    .from(pages)
    .where(and(
      inArray(pages.driveId, driveIds),
      eq(pages.type, 'FILE'),
      eq(pages.isTrashed, false)
    ));

  return Number(result[0]?.totalSize || 0);
}

/**
 * Get count of user's files
 */
export async function getUserFileCount(userId: string): Promise<number> {
  // Get all drives owned by user
  const userDrives = await db.query.drives.findMany({
    where: eq(drives.ownerId, userId),
    columns: { id: true }
  });

  if (userDrives.length === 0) return 0;

  const driveIds = userDrives.map(d => d.id);

  const result = await db
    .select({
      count: sql<number>`COUNT(*)`
    })
    .from(pages)
    .where(and(
      inArray(pages.driveId, driveIds),
      eq(pages.type, 'FILE'),
      eq(pages.isTrashed, false)
    ));

  return Number(result[0]?.count || 0);
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
  const actualUsage = await calculateActualStorageUsage(userId);

  if (!quota) {
    throw new Error('User not found');
  }

  const difference = actualUsage - quota.usedBytes;

  // Update if there's a discrepancy
  if (Math.abs(difference) > 1) { // Allow 1 byte tolerance for floating point
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          storageUsedBytes: actualUsage,
          lastStorageCalculated: new Date()
        })
        .where(eq(users.id, userId));

      await tx.insert(storageEvents).values({
        userId,
        eventType: 'reconcile',
        sizeDelta: difference,
        totalSizeAfter: actualUsage,
        metadata: {
          previousUsage: quota.usedBytes,
          actualUsage,
          difference
        }
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