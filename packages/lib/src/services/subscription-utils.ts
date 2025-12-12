/**
 * Utilities for computing storage limits and tiers from subscription data
 * This replaces the complex sync logic with simple computed values
 */

export type SubscriptionTier = 'free' | 'pro' | 'founder' | 'business';
export type StorageTier = 'free' | 'pro' | 'founder' | 'business';

export interface StorageConfig {
  tier: StorageTier;
  quotaBytes: number;
  maxFileSize: number;
  maxConcurrentUploads: number;
  maxFileCount: number;
  features: string[];
}

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
 * Get storage quota in bytes from subscription tier
 */
export function getStorageQuotaFromSubscription(subscriptionTier: SubscriptionTier): number {
  if (subscriptionTier === 'business') return 50 * 1024 * 1024 * 1024; // 50GB for business
  if (subscriptionTier === 'founder') return 10 * 1024 * 1024 * 1024;  // 10GB for founder
  if (subscriptionTier === 'pro') return 2 * 1024 * 1024 * 1024;       // 2GB for pro
  return 500 * 1024 * 1024;                                            // 500MB for free
}

/**
 * Get complete storage configuration from subscription tier
 */
export function getStorageConfigFromSubscription(subscriptionTier: SubscriptionTier): StorageConfig {
  if (subscriptionTier === 'business') {
    return {
      tier: 'business',
      quotaBytes: 50 * 1024 * 1024 * 1024,    // 50GB
      maxFileSize: 100 * 1024 * 1024,         // 100MB
      maxConcurrentUploads: 10,
      maxFileCount: 5000,
      features: ['50GB storage', '100MB per file']
    };
  }

  if (subscriptionTier === 'founder') {
    return {
      tier: 'founder',
      quotaBytes: 10 * 1024 * 1024 * 1024,    // 10GB
      maxFileSize: 50 * 1024 * 1024,          // 50MB
      maxConcurrentUploads: 3,
      maxFileCount: 500,
      features: ['10GB storage', '50MB per file']
    };
  }

  if (subscriptionTier === 'pro') {
    return {
      tier: 'pro',
      quotaBytes: 2 * 1024 * 1024 * 1024,     // 2GB
      maxFileSize: 50 * 1024 * 1024,          // 50MB
      maxConcurrentUploads: 3,
      maxFileCount: 500,
      features: ['2GB storage', '50MB per file']
    };
  }

  return {
    tier: 'free',
    quotaBytes: 500 * 1024 * 1024,           // 500MB
    maxFileSize: 20 * 1024 * 1024,           // 20MB
    maxConcurrentUploads: 2,
    maxFileCount: 100,
    features: ['500MB storage', '20MB per file', 'Basic processing']
  };
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