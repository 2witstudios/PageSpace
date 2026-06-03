/**
 * Utilities for computing storage limits and tiers from subscription data
 * This replaces the complex sync logic with simple computed values
 */

import { isOnPrem, isTenantMode } from '../deployment-mode';

export type SubscriptionTier = 'free' | 'pro' | 'founder' | 'business';
export type StorageTier = 'free' | 'pro' | 'founder' | 'business';

export interface StorageConfig {
  name: string;
  tier: StorageTier;
  quotaBytes: number;
  maxFileSize: number;
  maxConcurrentUploads: number;
  maxFileCount: number;
  features: string[];
}

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

/**
 * Single source of truth for storage tier limits.
 *
 * Every enforcement and display path derives from this table:
 *   - upload-validation.ts (per-file size gate)
 *   - storage-limits.ts (re-exports STORAGE_TIERS; quota + file-count gate)
 *   - apps/web .../plans.ts mirrors these numbers for marketing copy
 *
 * Limits reflect the higher of the previously-divergent tables — Tigris
 * comfortably handles the larger per-file ceilings.
 */
export const STORAGE_TIERS: Record<StorageTier, StorageConfig> = {
  free: {
    name: 'Free',
    tier: 'free',
    quotaBytes: 500 * MB,
    maxFileSize: 50 * MB,
    maxConcurrentUploads: 3,
    maxFileCount: 100,
    features: ['500MB storage', '50MB per file', 'Basic processing'],
  },
  pro: {
    name: 'Pro',
    tier: 'pro',
    quotaBytes: 2 * GB,
    maxFileSize: 250 * MB,
    maxConcurrentUploads: 5,
    maxFileCount: 500,
    features: ['2GB storage', '250MB per file'],
  },
  founder: {
    name: 'Founder',
    tier: 'founder',
    quotaBytes: 10 * GB,
    maxFileSize: 500 * MB,
    maxConcurrentUploads: 5,
    maxFileCount: 500,
    features: ['10GB storage', '500MB per file'],
  },
  business: {
    name: 'Business',
    tier: 'business',
    quotaBytes: 50 * GB,
    maxFileSize: 1 * GB,
    maxConcurrentUploads: 10,
    maxFileCount: 5000,
    features: ['50GB storage', '1GB per file'],
  },
};

/**
 * Get storage tier from subscription tier
 */
export function getStorageTierFromSubscription(subscriptionTier: SubscriptionTier): StorageTier {
  if (subscriptionTier === 'business') return 'business';
  if (subscriptionTier === 'founder') return 'founder';
  if (subscriptionTier === 'pro') return 'pro';
  return 'free';
}

/**
 * Get storage quota in bytes from subscription tier.
 * Delegates to getStorageConfigFromSubscription so the on-prem/tenant override
 * is honored consistently (otherwise these two could disagree for on-prem).
 */
export function getStorageQuotaFromSubscription(subscriptionTier: SubscriptionTier): number {
  return getStorageConfigFromSubscription(subscriptionTier).quotaBytes;
}

/**
 * Get complete storage configuration from subscription tier.
 * On-prem / tenant: always returns business-tier limits regardless of stored tier.
 */
export function getStorageConfigFromSubscription(subscriptionTier: SubscriptionTier): StorageConfig {
  if (isOnPrem() || isTenantMode()) {
    return STORAGE_TIERS.business;
  }
  return STORAGE_TIERS[getStorageTierFromSubscription(subscriptionTier)];
}

/**
 * Check if a subscription tier allows a feature
 */
export function subscriptionAllows(subscriptionTier: SubscriptionTier, feature: string): boolean {
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