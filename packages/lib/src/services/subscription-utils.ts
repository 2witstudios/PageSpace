/**
 * Storage-limit enforcement derived from the canonical tier table.
 *
 * The tier vocabulary and every limit number live in
 * `../billing/subscription-tiers` (TIER_PLAN_LIMITS); this module derives the
 * storage-enforcement view of that table and applies the on-prem/tenant
 * override. The old SubscriptionTier/StorageTier distinction collapsed long
 * ago — both names now alias the canonical SubscriptionTier.
 */

import { isOnPrem, isTenantMode } from '../deployment-mode';
import {
  TIERS,
  TIER_PLAN_LIMITS,
  formatTierBytes,
  toSubscriptionTier,
  type SubscriptionTier,
} from '../billing/subscription-tiers';

export type { SubscriptionTier };
export type StorageTier = SubscriptionTier;

export interface StorageConfig {
  name: string;
  tier: StorageTier;
  quotaBytes: number;
  maxFileSize: number;
  maxConcurrentUploads: number;
  maxFileCount: number;
  features: string[];
}

/**
 * Storage-enforcement view of the canonical TIER_PLAN_LIMITS table — used by
 * upload-validation.ts (per-file size gate) and storage-limits.ts (quota +
 * file-count gate). Display surfaces (apps/web plans.ts, marketing pricing)
 * derive from the same canonical table, so the numbers cannot drift.
 */
export const STORAGE_TIERS: Record<StorageTier, StorageConfig> = Object.fromEntries(
  TIERS.map((tier) => {
    const limits = TIER_PLAN_LIMITS[tier];
    const features = [
      `${formatTierBytes(limits.quotaBytes)} storage`,
      `${formatTierBytes(limits.maxFileSize)} per file`,
      ...(tier === 'free' ? ['Basic processing'] : []),
    ];
    return [
      tier,
      {
        name: limits.name,
        tier,
        quotaBytes: limits.quotaBytes,
        maxFileSize: limits.maxFileSize,
        maxConcurrentUploads: limits.maxConcurrentUploads,
        maxFileCount: limits.maxFileCount,
        features,
      },
    ];
  }),
) as Record<StorageTier, StorageConfig>;

/**
 * Get storage quota in bytes from subscription tier.
 * Delegates to getStorageConfigFromSubscription so the on-prem/tenant override
 * is honored consistently (otherwise these two could disagree for on-prem).
 */
export function getStorageQuotaFromSubscription(subscriptionTier: SubscriptionTier | string): number {
  return getStorageConfigFromSubscription(subscriptionTier).quotaBytes;
}

/**
 * Get complete storage configuration from subscription tier.
 * On-prem / tenant: always returns business-tier limits regardless of stored tier.
 * The stored column is untyped text, so unknown values coerce to 'free'.
 */
export function getStorageConfigFromSubscription(subscriptionTier: SubscriptionTier | string): StorageConfig {
  if (isOnPrem() || isTenantMode()) {
    return STORAGE_TIERS.business;
  }
  return STORAGE_TIERS[toSubscriptionTier(subscriptionTier)];
}

/**
 * Check if a subscription tier allows a feature
 */
export function subscriptionAllows(subscriptionTier: SubscriptionTier | string, feature: string): boolean {
  const config = getStorageConfigFromSubscription(subscriptionTier);
  return config.features.includes(feature);
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
