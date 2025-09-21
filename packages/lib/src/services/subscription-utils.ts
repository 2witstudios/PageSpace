/**
 * Utilities for computing storage limits and tiers from subscription data
 * This replaces the complex sync logic with simple computed values
 */

export type SubscriptionTier = 'free' | 'starter' | 'professional' | 'business' | 'enterprise';
export type StorageTier = 'free' | 'starter' | 'professional' | 'business' | 'enterprise';

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
  return subscriptionTier;
}

/**
 * Get storage quota in bytes from subscription tier
 */
export function getStorageQuotaFromSubscription(subscriptionTier: SubscriptionTier): number {
  switch (subscriptionTier) {
    case 'free':
      return 100 * 1024 * 1024;           // 100MB
    case 'starter':
      return 2 * 1024 * 1024 * 1024;      // 2GB
    case 'professional':
      return 10 * 1024 * 1024 * 1024;     // 10GB
    case 'business':
      return 50 * 1024 * 1024 * 1024;     // 50GB
    case 'enterprise':
      return 100 * 1024 * 1024 * 1024;    // 100GB
    default:
      return 100 * 1024 * 1024;           // 100MB default
  }
}

/**
 * Get complete storage configuration from subscription tier
 */
export function getStorageConfigFromSubscription(subscriptionTier: SubscriptionTier): StorageConfig {
  switch (subscriptionTier) {
    case 'free':
      return {
        tier: 'free',
        quotaBytes: 100 * 1024 * 1024,          // 100MB
        maxFileSize: 10 * 1024 * 1024,          // 10MB
        maxConcurrentUploads: 1,
        maxFileCount: 50,
        features: ['100MB storage', '10MB per file', 'Basic processing']
      };
    case 'starter':
      return {
        tier: 'starter',
        quotaBytes: 2 * 1024 * 1024 * 1024,     // 2GB
        maxFileSize: 25 * 1024 * 1024,          // 25MB
        maxConcurrentUploads: 2,
        maxFileCount: 200,
        features: ['2GB storage', '25MB per file', 'Standard processing']
      };
    case 'professional':
      return {
        tier: 'professional',
        quotaBytes: 10 * 1024 * 1024 * 1024,    // 10GB
        maxFileSize: 50 * 1024 * 1024,          // 50MB
        maxConcurrentUploads: 3,
        maxFileCount: 1000,
        features: ['10GB storage', '50MB per file', 'Priority processing']
      };
    case 'business':
      return {
        tier: 'business',
        quotaBytes: 50 * 1024 * 1024 * 1024,    // 50GB
        maxFileSize: 100 * 1024 * 1024,         // 100MB
        maxConcurrentUploads: 5,
        maxFileCount: 5000,
        features: ['50GB storage', '100MB per file', 'Fast processing', 'Team collaboration']
      };
    case 'enterprise':
      return {
        tier: 'enterprise',
        quotaBytes: 100 * 1024 * 1024 * 1024,   // 100GB
        maxFileSize: 500 * 1024 * 1024,         // 500MB
        maxConcurrentUploads: 10,
        maxFileCount: 50000,
        features: ['100GB storage', '500MB per file', 'Dedicated processing', 'Advanced team features', 'SLA support']
      };
    default:
      return {
        tier: 'free',
        quotaBytes: 100 * 1024 * 1024,          // 100MB
        maxFileSize: 10 * 1024 * 1024,          // 10MB
        maxConcurrentUploads: 1,
        maxFileCount: 50,
        features: ['100MB storage', '10MB per file', 'Basic processing']
      };
  }
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