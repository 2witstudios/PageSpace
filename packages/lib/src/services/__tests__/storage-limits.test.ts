import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../storage-repository', () => ({
  storageRepository: {
    findUserForStorage: vi.fn(),
    findUserForUploads: vi.fn(),
    findUserDriveIds: vi.fn(),
    findFilesByCreator: vi.fn(),
    userReferencesContentHash: vi.fn(),
    countFiles: vi.fn(),
    updateActiveUploads: vi.fn(),
    updateStorageInTx: vi.fn(),
    insertStorageEvent: vi.fn(),
    setUserStorageInTx: vi.fn(),
    runTransaction: vi.fn(),
  },
}));

vi.mock('../subscription-utils', async (importOriginal) => {
  // Spread the real module so the canonical STORAGE_TIERS table (now the single
  // source of truth) is preserved; override only the tier-config resolvers.
  const actual = await importOriginal<typeof import('../subscription-utils')>();
  return {
    ...actual,
    getStorageConfigFromSubscription: vi.fn((tier: string) => {
      if (tier === 'free') return { name: 'Free', tier: 'free', quotaBytes: 500 * 1024 * 1024, maxFileSize: 50 * 1024 * 1024, maxConcurrentUploads: 3, maxFileCount: 100, features: [] };
      if (tier === 'pro') return { name: 'Pro', tier: 'pro', quotaBytes: 2 * 1024 * 1024 * 1024, maxFileSize: 250 * 1024 * 1024, maxConcurrentUploads: 5, maxFileCount: 500, features: [] };
      return { name: 'Business', tier: 'business', quotaBytes: 50 * 1024 * 1024 * 1024, maxFileSize: 1024 * 1024 * 1024, maxConcurrentUploads: 10, maxFileCount: 5000, features: [] };
    }),
  };
});

import {
  getUserStorageQuota,
  checkStorageQuota,
  checkConcurrentUploads,
  updateStorageUsage,
  updateActiveUploads,
  calculateActualStorageUsage,
  getUserFileCount,
  reconcileStorageUsage,
  userReferencesContentHash,
  toByteCount,
  sumStorageBytes,
  shouldChargeForStore,
  computeStorageCreditOnUnlink,
  formatBytes,
  parseBytes,
  STORAGE_TIERS,
} from '../storage-limits';
import { storageRepository } from '../storage-repository';

describe('storage-limits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      expect(STORAGE_TIERS.free.maxFileSize).toBe(50 * 1024 * 1024);
      expect(STORAGE_TIERS.free.maxConcurrentUploads).toBe(3);
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

      const result = await checkStorageQuota('user-1', 60 * 1024 * 1024);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('exceeds');
      expect(result.requiredBytes).toBe(60 * 1024 * 1024);
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
        activeUploads: 3, subscriptionTier: 'free',
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

      const txCallback = vi.mocked(storageRepository.runTransaction).mock.calls[0][0];
      expect(typeof txCallback).toBe('function');
      expect(storageRepository.updateStorageInTx).toHaveBeenCalledWith(
        {}, 'user-1', 1024,
      );
      expect(storageRepository.insertStorageEvent).toHaveBeenCalledWith(
        {},
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

  describe('calculateActualStorageUsage (H4 — reconcile basis = files.createdBy)', () => {
    it('returns 0 when the user created no files', async () => {
      vi.mocked(storageRepository.findFilesByCreator).mockResolvedValue([]);

      const result = await calculateActualStorageUsage('user-1');

      expect(result).toBe(0);
      expect(storageRepository.findFilesByCreator).toHaveBeenCalledWith('user-1');
    });

    it('sums the byte sizes of every file the user created (the charge population)', async () => {
      vi.mocked(storageRepository.findFilesByCreator).mockResolvedValue([
        { sizeBytes: 1024 },
        { sizeBytes: 2048 },
      ]);

      const result = await calculateActualStorageUsage('user-1');

      expect(result).toBe(3072);
    });

    it('does NOT scope to owned drives (cross-drive uploads are still the uploader\'s bytes)', async () => {
      vi.mocked(storageRepository.findFilesByCreator).mockResolvedValue([{ sizeBytes: 500 }]);

      await calculateActualStorageUsage('user-1');

      // The owner-drive query is the H4 bug; reconcile must not use it.
      expect(storageRepository.findUserDriveIds).not.toHaveBeenCalled();
    });
  });

  describe('userReferencesContentHash (H3)', () => {
    it('delegates to the repository with user, hash, and drive', async () => {
      vi.mocked(storageRepository.userReferencesContentHash).mockResolvedValue(true);

      const result = await userReferencesContentHash('user-1', 'a'.repeat(64), 'drive-1');

      expect(result).toBe(true);
      expect(storageRepository.userReferencesContentHash).toHaveBeenCalledWith('user-1', 'a'.repeat(64), 'drive-1');
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

  describe('toByteCount', () => {
    it('passes through a positive integer', () => {
      expect(toByteCount(1024)).toBe(1024);
    });

    it('coerces a BIGINT-as-string to a number', () => {
      expect(toByteCount('2048')).toBe(2048);
    });

    it('floors a fractional value to an integer', () => {
      expect(toByteCount(1024.9)).toBe(1024);
    });

    it('treats null/undefined/negative/NaN as 0', () => {
      expect(toByteCount(null)).toBe(0);
      expect(toByteCount(undefined)).toBe(0);
      expect(toByteCount(-5)).toBe(0);
      expect(toByteCount('not-a-number')).toBe(0);
    });
  });

  describe('sumStorageBytes (H4)', () => {
    it('returns 0 for an empty population', () => {
      expect(sumStorageBytes([])).toBe(0);
    });

    it('sums numeric byte sizes', () => {
      expect(sumStorageBytes([{ sizeBytes: 100 }, { sizeBytes: 200 }, { sizeBytes: 300 }])).toBe(600);
    });

    it('sums BIGINT-as-string byte sizes (Postgres bigint mode)', () => {
      expect(sumStorageBytes([{ sizeBytes: '100' }, { sizeBytes: '250' }])).toBe(350);
    });

    it('ignores null/garbage rows so one bad row cannot poison the total', () => {
      expect(sumStorageBytes([{ sizeBytes: 100 }, { sizeBytes: null }, { sizeBytes: 'x' as unknown as string }])).toBe(100);
    });
  });

  describe('shouldChargeForStore (M8 — charge once, on first physical store)', () => {
    it('charges when the files row was newly inserted', () => {
      expect(shouldChargeForStore(true)).toBe(true);
    });

    it('does not charge on a dedup completion (row already existed)', () => {
      expect(shouldChargeForStore(false)).toBe(false);
    });
  });

  describe('computeStorageCreditOnUnlink (M8 — credit once, to the uploader)', () => {
    const base = { createdBy: 'u1', sizeBytes: 2048, deletedByThisCall: true, hadPhysicalBlob: true };

    it('credits the uploader the negative byte delta when this call deleted the row', () => {
      expect(computeStorageCreditOnUnlink(base)).toEqual({ userId: 'u1', deltaBytes: -2048 });
    });

    it('coerces BIGINT-as-string sizes and negates them', () => {
      expect(computeStorageCreditOnUnlink({ ...base, sizeBytes: '4096' })).toEqual({ userId: 'u1', deltaBytes: -4096 });
    });

    it('returns null when another reap already deleted the row (race-safe)', () => {
      expect(computeStorageCreditOnUnlink({ ...base, deletedByThisCall: false })).toBeNull();
    });

    it('returns null for a DB-only stub whose bytes were never persisted', () => {
      expect(computeStorageCreditOnUnlink({ ...base, hadPhysicalBlob: false })).toBeNull();
    });

    it('returns null when createdBy was nulled by a user-delete cascade', () => {
      expect(computeStorageCreditOnUnlink({ ...base, createdBy: null })).toBeNull();
    });

    it('returns null for a zero / invalid byte size', () => {
      expect(computeStorageCreditOnUnlink({ ...base, sizeBytes: 0 })).toBeNull();
    });
  });
});
