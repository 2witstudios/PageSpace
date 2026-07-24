import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../deployment-mode', () => ({
  isOnPrem: vi.fn(() => false),
  isTenantMode: vi.fn(() => false),
}));

import {
  getStorageQuotaFromSubscription,
  getStorageConfigFromSubscription,
  subscriptionAllows,
  formatBytes,
} from '../subscription-utils';
import { isOnPrem, isTenantMode } from '../../deployment-mode';

describe('subscription-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isOnPrem).mockReturnValue(false);
    vi.mocked(isTenantMode).mockReturnValue(false);
  });

  describe('unknown stored tier coercion', () => {
    it('should fall back to free-tier config for values outside the vocabulary', () => {
      expect(getStorageConfigFromSubscription('enterprise').tier).toBe('free');
      expect(getStorageQuotaFromSubscription('garbage')).toBe(500 * 1024 * 1024);
    });
  });

  describe('getStorageQuotaFromSubscription', () => {
    it('should return 50GB for business', () => {
      expect(getStorageQuotaFromSubscription('business')).toBe(50 * 1024 * 1024 * 1024);
    });

    it('should return 10GB for founder', () => {
      expect(getStorageQuotaFromSubscription('founder')).toBe(10 * 1024 * 1024 * 1024);
    });

    it('should return 2GB for pro', () => {
      expect(getStorageQuotaFromSubscription('pro')).toBe(2 * 1024 * 1024 * 1024);
    });

    it('should return 500MB for free', () => {
      expect(getStorageQuotaFromSubscription('free')).toBe(500 * 1024 * 1024);
    });
  });

  describe('getStorageConfigFromSubscription', () => {
    it('should return business config for on-prem regardless of tier', () => {
      vi.mocked(isOnPrem).mockReturnValue(true);
      const config = getStorageConfigFromSubscription('free');
      expect(config.tier).toBe('business');
      expect(config.maxConcurrentUploads).toBe(10);
    });

    it('should return business config for tenant mode regardless of tier', () => {
      vi.mocked(isTenantMode).mockReturnValue(true);
      const config = getStorageConfigFromSubscription('free');
      expect(config.tier).toBe('business');
      expect(config.quotaBytes).toBe(50 * 1024 * 1024 * 1024);
      expect(config.maxConcurrentUploads).toBe(10);
    });

    it('should return business config', () => {
      const config = getStorageConfigFromSubscription('business');
      expect(config.tier).toBe('business');
      expect(config.maxFileSize).toBe(1024 * 1024 * 1024);
      expect(config.maxFileCount).toBe(5000);
    });

    it('should return founder config', () => {
      const config = getStorageConfigFromSubscription('founder');
      expect(config.tier).toBe('founder');
      expect(config.quotaBytes).toBe(10 * 1024 * 1024 * 1024);
    });

    it('should return pro config', () => {
      const config = getStorageConfigFromSubscription('pro');
      expect(config.tier).toBe('pro');
      expect(config.quotaBytes).toBe(2 * 1024 * 1024 * 1024);
    });

    it('should return free config', () => {
      const config = getStorageConfigFromSubscription('free');
      expect(config.tier).toBe('free');
      expect(config.maxFileSize).toBe(50 * 1024 * 1024);
      expect(config.maxFileCount).toBe(100);
    });
  });

  describe('subscriptionAllows', () => {
    it('should return true for feature in tier', () => {
      expect(subscriptionAllows('free', '500MB storage')).toBe(true);
    });

    it('should return false for feature not in tier', () => {
      expect(subscriptionAllows('free', '50GB storage')).toBe(false);
    });
  });

  describe('formatBytes', () => {
    it('should format 0 bytes', () => {
      expect(formatBytes(0)).toBe('0 B');
    });

    it('should format bytes', () => {
      expect(formatBytes(500)).toBe('500 B');
    });

    it('should format kilobytes', () => {
      expect(formatBytes(1024)).toBe('1 KB');
    });

    it('should format megabytes', () => {
      expect(formatBytes(1024 * 1024)).toBe('1 MB');
    });

    it('should format gigabytes', () => {
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    });
  });
});
