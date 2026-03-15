import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../storage-repository', () => ({
  storageRepository: {
    findUserForStorage: vi.fn(),
    findUserForUploads: vi.fn(),
    findUserDriveIds: vi.fn(),
    sumFileSize: vi.fn(),
    countFiles: vi.fn(),
    updateActiveUploads: vi.fn(),
    updateStorageInTx: vi.fn(),
    insertStorageEvent: vi.fn(),
    setUserStorageInTx: vi.fn(),
    runTransaction: vi.fn(),
  },
}));

vi.mock('../subscription-utils', () => ({
  getStorageConfigFromSubscription: vi.fn((tier: string) => {
    if (tier === 'free') return { tier: 'free', quotaBytes: 500 * 1024 * 1024, maxFileSize: 20 * 1024 * 1024, maxConcurrentUploads: 2, maxFileCount: 100, features: [] };
    if (tier === 'pro') return { tier: 'pro', quotaBytes: 2 * 1024 * 1024 * 1024, maxFileSize: 50 * 1024 * 1024, maxConcurrentUploads: 3, maxFileCount: 500, features: [] };
    return { tier: 'business', quotaBytes: 50 * 1024 * 1024 * 1024, maxFileSize: 100 * 1024 * 1024, maxConcurrentUploads: 10, maxFileCount: 5000, features: [] };
  }),
  getStorageTierFromSubscription: vi.fn((tier: string) => tier),
}));

import {
  getUserStorageQuota,
  checkStorageQuota,
  checkConcurrentUploads,
  updateStorageUsage,
  updateActiveUploads,
  calculateActualStorageUsage,
  getUserFileCount,
  reconcileStorageUsage,
  formatBytes,
  parseBytes,
  STORAGE_TIERS,
  mapSubscriptionToStorageTier,
  changeUserTier,
  updateStorageTierFromSubscription,
} from '../storage-limits';
import { storageRepository } from '../storage-repository';

describe('storage-limits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('mapSubscriptionToStorageTier', () => {
    it('mapSubscriptionToStorageTier_withFreeTier_returnsFree', () => {
      expect(mapSubscriptionToStorageTier('free')).toBe('free');
    });

    it('mapSubscriptionToStorageTier_withProTier_returnsPro', () => {
      expect(mapSubscriptionToStorageTier('pro')).toBe('pro');
    });

    it('mapSubscriptionToStorageTier_withBusinessTier_returnsBusiness', () => {
      expect(mapSubscriptionToStorageTier('business')).toBe('business');
    });
  });

  describe('STORAGE_TIERS', () => {
    it('STORAGE_TIERS_allTiers_areDefined', () => {
      expect(STORAGE_TIERS.free).toBeDefined();
      expect(STORAGE_TIERS.pro).toBeDefined();
      expect(STORAGE_TIERS.founder).toBeDefined();
      expect(STORAGE_TIERS.business).toBeDefined();
    });

    it('STORAGE_TIERS_freeTier_hasExpectedQuota', () => {
      expect(STORAGE_TIERS.free.quotaBytes).toBe(500 * 1024 * 1024);
      expect(STORAGE_TIERS.free.maxFileSize).toBe(20 * 1024 * 1024);
      expect(STORAGE_TIERS.free.maxConcurrentUploads).toBe(2);
      expect(STORAGE_TIERS.free.maxFileCount).toBe(100);
    });
  });

  describe('getUserStorageQuota', () => {
    it('getUserStorageQuota_withNonexistentUser_returnsNull', async () => {
      vi.mocked(storageRepository.findUserForStorage).mockResolvedValue(undefined);

      const result = await getUserStorageQuota('nonexistent');

      expect(result).toBeNull();
      expect(storageRepository.findUserForStorage).toHaveBeenCalledWith('nonexistent');
    });

    it('getUserStorageQuota_withExistingFreeUser_returnsQuotaWithCorrectAvailableBytes', async () => {
      vi.mocked(storageRepository.findUserForStorage).mockResolvedValue({
        id: 'user-1',
        storageUsedBytes: 100 * 1024 * 1024,
        subscriptionTier: 'free',
      });

      const result = await getUserStorageQuota('user-1');

      expect(result).not.toBeNull();
      expect(result!.tier).toBe('free');
      expect(result!.usedBytes).toBe(100 * 1024 * 1024);
      expect(result!.availableBytes).toBe(400 * 1024 * 1024);
      expect(result!.warningLevel).toBe('none');
    });

    it('getUserStorageQuota_withNullSubscriptionTier_defaultsToFree', async () => {
      vi.mocked(storageRepository.findUserForStorage).mockResolvedValue({
        id: 'user-1',
        storageUsedBytes: 0,
        subscriptionTier: null,
      });

      const result = await getUserStorageQuota('user-1');

      expect(result).not.toBeNull();
      expect(result!.tier).toBe('free');
    });

    it('getUserStorageQuota_withUsageAt95Percent_returnsCriticalWarning', async () => {
      vi.mocked(storageRepository.findUserForStorage).mockResolvedValue({
        id: 'user-1',
        storageUsedBytes: 490 * 1024 * 1024,
        subscriptionTier: 'free',
      });

      const result = await getUserStorageQuota('user-1');

      expect(result!.warningLevel).toBe('critical');
      expect(result!.utilizationPercent).toBeGreaterThanOrEqual(95);
    });

    it('getUserStorageQuota_withUsageAt80Percent_returnsWarning', async () => {
      vi.mocked(storageRepository.findUserForStorage).mockResolvedValue({
        id: 'user-1',
        storageUsedBytes: 420 * 1024 * 1024,
        subscriptionTier: 'free',
      });

      const result = await getUserStorageQuota('user-1');

      expect(result!.warningLevel).toBe('warning');
    });
  });

  describe('checkStorageQuota', () => {
    it('checkStorageQuota_withNonexistentUser_returnsNotAllowed', async () => {
      vi.mocked(storageRepository.findUserForStorage).mockResolvedValue(undefined);

      const result = await checkStorageQuota('nonexistent', 1024);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('User not found');
    });

    it('checkStorageQuota_withFileExceedingTierLimit_rejectsWithReason', async () => {
      vi.mocked(storageRepository.findUserForStorage).mockResolvedValue({
        id: 'user-1', storageUsedBytes: 0, subscriptionTier: 'free',
      });

      const result = await checkStorageQuota('user-1', 25 * 1024 * 1024);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('exceeds');
      expect(result.requiredBytes).toBe(25 * 1024 * 1024);
    });

    it('checkStorageQuota_withInsufficientStorage_rejectsWithReason', async () => {
      vi.mocked(storageRepository.findUserForStorage).mockResolvedValue({
        id: 'user-1', storageUsedBytes: 499 * 1024 * 1024, subscriptionTier: 'free',
      });

      const result = await checkStorageQuota('user-1', 10 * 1024 * 1024);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Insufficient storage');
    });

    it('checkStorageQuota_withValidUpload_returnsAllowed', async () => {
      vi.mocked(storageRepository.findUserForStorage).mockResolvedValue({
        id: 'user-1', storageUsedBytes: 0, subscriptionTier: 'free',
      });
      vi.mocked(storageRepository.findUserDriveIds).mockResolvedValue(['drive-1']);
      vi.mocked(storageRepository.countFiles).mockResolvedValue(5);

      const result = await checkStorageQuota('user-1', 1024);

      expect(result.allowed).toBe(true);
      expect(result.quota).toBeDefined();
    });

    it('checkStorageQuota_withFileCountAtLimit_rejectsWithReason', async () => {
      vi.mocked(storageRepository.findUserForStorage).mockResolvedValue({
        id: 'user-1', storageUsedBytes: 0, subscriptionTier: 'free',
      });
      vi.mocked(storageRepository.findUserDriveIds).mockResolvedValue(['drive-1']);
      vi.mocked(storageRepository.countFiles).mockResolvedValue(100);

      const result = await checkStorageQuota('user-1', 1024);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('File count limit');
    });
  });

  describe('checkConcurrentUploads', () => {
    it('checkConcurrentUploads_withNonexistentUser_returnsFalse', async () => {
      vi.mocked(storageRepository.findUserForUploads).mockResolvedValue(undefined);

      expect(await checkConcurrentUploads('nonexistent')).toBe(false);
    });

    it('checkConcurrentUploads_withUploadsUnderLimit_returnsTrue', async () => {
      vi.mocked(storageRepository.findUserForUploads).mockResolvedValue({
        activeUploads: 0, subscriptionTier: 'free',
      });

      expect(await checkConcurrentUploads('user-1')).toBe(true);
    });

    it('checkConcurrentUploads_withUploadsAtLimit_returnsFalse', async () => {
      vi.mocked(storageRepository.findUserForUploads).mockResolvedValue({
        activeUploads: 2, subscriptionTier: 'free',
      });

      expect(await checkConcurrentUploads('user-1')).toBe(false);
    });
  });

  describe('updateStorageUsage', () => {
    it('updateStorageUsage_withNoExistingTx_createsNewTransaction', async () => {
      vi.mocked(storageRepository.runTransaction).mockImplementation(async (fn) => {
        const mockTx = {} as never;
        return fn(mockTx);
      });
      vi.mocked(storageRepository.updateStorageInTx).mockResolvedValue({ newUsage: 1024 });
      vi.mocked(storageRepository.insertStorageEvent).mockResolvedValue(undefined);

      await updateStorageUsage('user-1', 1024, { eventType: 'upload', pageId: 'page-1' });

      expect(storageRepository.runTransaction).toHaveBeenCalledWith(expect.any(Function));
      expect(storageRepository.updateStorageInTx).toHaveBeenCalledWith(
        expect.anything(), 'user-1', 1024,
      );
      expect(storageRepository.insertStorageEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: 'user-1',
          eventType: 'upload',
          pageId: 'page-1',
          sizeDelta: 1024,
          totalSizeAfter: 1024,
        }),
      );
    });

    it('updateStorageUsage_withExistingTx_usesProvidedTransaction', async () => {
      const existingTx = {} as never;
      vi.mocked(storageRepository.updateStorageInTx).mockResolvedValue({ newUsage: 1024 });
      vi.mocked(storageRepository.insertStorageEvent).mockResolvedValue(undefined);

      await updateStorageUsage('user-1', 1024, { eventType: 'upload' }, existingTx);

      expect(storageRepository.runTransaction).not.toHaveBeenCalled();
      expect(storageRepository.updateStorageInTx).toHaveBeenCalledWith(
        existingTx, 'user-1', 1024,
      );
    });

    it('updateStorageUsage_withNoContext_skipsStorageEvent', async () => {
      vi.mocked(storageRepository.runTransaction).mockImplementation(async (fn) => {
        return fn({} as never);
      });
      vi.mocked(storageRepository.updateStorageInTx).mockResolvedValue({ newUsage: 0 });

      await updateStorageUsage('user-1', -500);

      expect(storageRepository.insertStorageEvent).not.toHaveBeenCalled();
    });
  });

  describe('updateActiveUploads', () => {
    it('updateActiveUploads_withDelta_delegatesToRepository', async () => {
      vi.mocked(storageRepository.updateActiveUploads).mockResolvedValue(undefined);

      await updateActiveUploads('user-1', 1);

      expect(storageRepository.updateActiveUploads).toHaveBeenCalledWith('user-1', 1);
    });
  });

  describe('calculateActualStorageUsage', () => {
    it('calculateActualStorageUsage_withNoDrives_returnsZero', async () => {
      vi.mocked(storageRepository.findUserDriveIds).mockResolvedValue([]);

      const result = await calculateActualStorageUsage('user-1');

      expect(result).toBe(0);
      expect(storageRepository.sumFileSize).not.toHaveBeenCalled();
    });

    it('calculateActualStorageUsage_withDrives_returnsTotalFileSize', async () => {
      vi.mocked(storageRepository.findUserDriveIds).mockResolvedValue(['drive-1']);
      vi.mocked(storageRepository.sumFileSize).mockResolvedValue(1024);

      const result = await calculateActualStorageUsage('user-1');

      expect(result).toBe(1024);
      expect(storageRepository.sumFileSize).toHaveBeenCalledWith(['drive-1']);
    });
  });

  describe('getUserFileCount', () => {
    it('getUserFileCount_withNoDrives_returnsZero', async () => {
      vi.mocked(storageRepository.findUserDriveIds).mockResolvedValue([]);

      expect(await getUserFileCount('user-1')).toBe(0);
    });

    it('getUserFileCount_withDrives_returnsCountFromRepository', async () => {
      vi.mocked(storageRepository.findUserDriveIds).mockResolvedValue(['drive-1']);
      vi.mocked(storageRepository.countFiles).mockResolvedValue(42);

      expect(await getUserFileCount('user-1')).toBe(42);
      expect(storageRepository.countFiles).toHaveBeenCalledWith(['drive-1']);
    });
  });

  describe('reconcileStorageUsage', () => {
    it('reconcileStorageUsage_withNonexistentUser_throwsUserNotFound', async () => {
      vi.mocked(storageRepository.findUserForStorage).mockResolvedValue(undefined);

      await expect(reconcileStorageUsage('nonexistent')).rejects.toThrow('User not found');
    });
  });

  describe('formatBytes', () => {
    it('formatBytes_withZero_returnsZeroB', () => {
      expect(formatBytes(0)).toBe('0 B');
    });

    it('formatBytes_with1024_returns1KB', () => {
      expect(formatBytes(1024)).toBe('1 KB');
    });

    it('formatBytes_withOneMB_returns1MB', () => {
      expect(formatBytes(1024 * 1024)).toBe('1 MB');
    });

    it('formatBytes_withOneGB_returns1GB', () => {
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    });
  });

  describe('parseBytes', () => {
    it('parseBytes_withBytesString_returnsBytes', () => {
      expect(parseBytes('500B')).toBe(500);
    });

    it('parseBytes_withKB_returnsCorrectBytes', () => {
      expect(parseBytes('1KB')).toBe(1024);
    });

    it('parseBytes_withMB_returnsCorrectBytes', () => {
      expect(parseBytes('10MB')).toBe(10 * 1024 * 1024);
    });

    it('parseBytes_withGB_returnsCorrectBytes', () => {
      expect(parseBytes('1GB')).toBe(1024 * 1024 * 1024);
    });

    it('parseBytes_withInvalidFormat_throwsError', () => {
      expect(() => parseBytes('invalid')).toThrow('Invalid size format');
    });

    it('parseBytes_withNullInput_throwsError', () => {
      expect(() => parseBytes(null as unknown as string)).toThrow('Invalid size parameter');
    });
  });

  describe('deprecated functions', () => {
    it('changeUserTier_whenCalled_throwsRemovedError', async () => {
      await expect(changeUserTier()).rejects.toThrow('changeUserTier has been removed');
    });

    it('updateStorageTierFromSubscription_whenCalled_throwsRemovedError', async () => {
      await expect(updateStorageTierFromSubscription()).rejects.toThrow('updateStorageTierFromSubscription has been removed');
    });
  });
});
