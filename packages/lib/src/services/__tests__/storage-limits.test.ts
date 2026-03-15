import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
      drives: { findMany: vi.fn() },
    },
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
  users: { id: 'id', storageUsedBytes: 'storageUsedBytes', activeUploads: 'activeUploads', subscriptionTier: 'subscriptionTier', lastStorageCalculated: 'lastStorageCalculated' },
  pages: { driveId: 'driveId', type: 'type', isTrashed: 'isTrashed', fileSize: 'fileSize' },
  drives: { ownerId: 'ownerId', id: 'id' },
  storageEvents: {},
  eq: vi.fn(),
  sql: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('./subscription-utils', () => ({
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
import { db } from '@pagespace/db';

describe('storage-limits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('mapSubscriptionToStorageTier', () => {
    it('should map subscription tiers correctly', () => {
      expect(mapSubscriptionToStorageTier('free')).toBe('free');
      expect(mapSubscriptionToStorageTier('pro')).toBe('pro');
      expect(mapSubscriptionToStorageTier('business')).toBe('business');
    });
  });

  describe('STORAGE_TIERS', () => {
    it('should define all tiers', () => {
      expect(STORAGE_TIERS.free).toBeDefined();
      expect(STORAGE_TIERS.pro).toBeDefined();
      expect(STORAGE_TIERS.founder).toBeDefined();
      expect(STORAGE_TIERS.business).toBeDefined();
    });
  });

  describe('getUserStorageQuota', () => {
    it('should return null when user not found', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined as never);
      const result = await getUserStorageQuota('nonexistent');
      expect(result).toBeNull();
    });

    it('should return quota for existing user', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        storageUsedBytes: 100 * 1024 * 1024, // 100MB
        subscriptionTier: 'free',
      } as never);

      const result = await getUserStorageQuota('user-1');
      expect(result).not.toBeNull();
      expect(result!.tier).toBe('free');
      expect(result!.usedBytes).toBe(100 * 1024 * 1024);
      expect(result!.availableBytes).toBe(400 * 1024 * 1024);
    });

    it('should handle null subscription tier', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        storageUsedBytes: 0,
        subscriptionTier: null,
      } as never);

      const result = await getUserStorageQuota('user-1');
      expect(result).not.toBeNull();
    });

    it('should return critical warning level when usage >= 95%', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        storageUsedBytes: 490 * 1024 * 1024, // 490MB out of 500MB
        subscriptionTier: 'free',
      } as never);

      const result = await getUserStorageQuota('user-1');
      expect(result!.warningLevel).toBe('critical');
    });

    it('should return warning level when usage >= 80%', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        storageUsedBytes: 420 * 1024 * 1024, // 420MB out of 500MB
        subscriptionTier: 'free',
      } as never);

      const result = await getUserStorageQuota('user-1');
      expect(result!.warningLevel).toBe('warning');
    });
  });

  describe('checkStorageQuota', () => {
    it('should return not allowed when user not found', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined as never);
      const result = await checkStorageQuota('nonexistent', 1024);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('User not found');
    });

    it('should reject file exceeding tier size limit', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1', storageUsedBytes: 0, subscriptionTier: 'free',
      } as never);

      const result = await checkStorageQuota('user-1', 25 * 1024 * 1024); // 25MB > 20MB free limit
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('exceeds');
    });

    it('should reject when insufficient storage available', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1', storageUsedBytes: 499 * 1024 * 1024, subscriptionTier: 'free',
      } as never);

      const result = await checkStorageQuota('user-1', 10 * 1024 * 1024); // 10MB but only 1MB available
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Insufficient storage');
    });

    it('should allow valid upload', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1', storageUsedBytes: 0, subscriptionTier: 'free',
      } as never);
      vi.mocked(db.query.drives.findMany).mockResolvedValue([{ id: 'drive-1' }] as never);
      const mockWhere = vi.fn().mockResolvedValue([{ count: 5 }]);
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      const result = await checkStorageQuota('user-1', 1024);
      expect(result.allowed).toBe(true);
    });
  });

  describe('checkConcurrentUploads', () => {
    it('should return false when user not found', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined as never);
      const result = await checkConcurrentUploads('nonexistent');
      expect(result).toBe(false);
    });

    it('should return true when under concurrent limit', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        activeUploads: 0, subscriptionTier: 'free',
      } as never);
      const result = await checkConcurrentUploads('user-1');
      expect(result).toBe(true);
    });

    it('should return false when at concurrent limit', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        activeUploads: 2, subscriptionTier: 'free',
      } as never);
      const result = await checkConcurrentUploads('user-1');
      expect(result).toBe(false);
    });
  });

  describe('updateStorageUsage', () => {
    it('should update storage within a new transaction', async () => {
      const mockTx = {
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([{ newUsage: 1024 }]),
            })),
          })),
        })),
        insert: vi.fn(() => ({ values: vi.fn() })),
      };
      vi.mocked(db.transaction).mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
        await fn(mockTx);
      });

      await updateStorageUsage('user-1', 1024, { eventType: 'upload', pageId: 'page-1' });
      expect(db.transaction).toHaveBeenCalled();
    });

    it('should use existing transaction when provided', async () => {
      const mockTx = {
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([{ newUsage: 1024 }]),
            })),
          })),
        })),
        insert: vi.fn(() => ({ values: vi.fn() })),
      };

      await updateStorageUsage('user-1', 1024, { eventType: 'upload' }, mockTx as never);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(mockTx.update).toHaveBeenCalled();
    });
  });

  describe('updateActiveUploads', () => {
    it('should update active uploads count', async () => {
      const mockWhere = vi.fn();
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);

      await updateActiveUploads('user-1', 1);
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('calculateActualStorageUsage', () => {
    it('should return 0 when user has no drives', async () => {
      vi.mocked(db.query.drives.findMany).mockResolvedValue([] as never);
      const result = await calculateActualStorageUsage('user-1');
      expect(result).toBe(0);
    });

    it('should calculate total file size across drives', async () => {
      vi.mocked(db.query.drives.findMany).mockResolvedValue([{ id: 'drive-1' }] as never);
      const mockWhere = vi.fn().mockResolvedValue([{ totalSize: 1024 }]);
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      const result = await calculateActualStorageUsage('user-1');
      expect(result).toBe(1024);
    });
  });

  describe('getUserFileCount', () => {
    it('should return 0 when user has no drives', async () => {
      vi.mocked(db.query.drives.findMany).mockResolvedValue([] as never);
      const result = await getUserFileCount('user-1');
      expect(result).toBe(0);
    });

    it('should return count from database', async () => {
      vi.mocked(db.query.drives.findMany).mockResolvedValue([{ id: 'drive-1' }] as never);
      const mockWhere = vi.fn().mockResolvedValue([{ count: 42 }]);
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      const result = await getUserFileCount('user-1');
      expect(result).toBe(42);
    });
  });

  describe('reconcileStorageUsage', () => {
    it('should throw when user not found', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined as never);
      await expect(reconcileStorageUsage('nonexistent')).rejects.toThrow('User not found');
    });
  });

  describe('formatBytes', () => {
    it('should format 0 bytes', () => {
      expect(formatBytes(0)).toBe('0 B');
    });

    it('should format KB', () => {
      expect(formatBytes(1024)).toBe('1 KB');
    });

    it('should format MB', () => {
      expect(formatBytes(1024 * 1024)).toBe('1 MB');
    });

    it('should format GB', () => {
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    });
  });

  describe('parseBytes', () => {
    it('should parse bytes', () => {
      expect(parseBytes('500B')).toBe(500);
    });

    it('should parse KB', () => {
      expect(parseBytes('1KB')).toBe(1024);
    });

    it('should parse MB', () => {
      expect(parseBytes('10MB')).toBe(10 * 1024 * 1024);
    });

    it('should parse GB', () => {
      expect(parseBytes('1GB')).toBe(1024 * 1024 * 1024);
    });

    it('should throw for invalid format', () => {
      expect(() => parseBytes('invalid')).toThrow('Invalid size format');
    });

    it('should throw for null/undefined input', () => {
      expect(() => parseBytes(null as unknown as string)).toThrow('Invalid size parameter');
    });
  });

  describe('deprecated functions', () => {
    it('changeUserTier should throw', async () => {
      await expect(changeUserTier()).rejects.toThrow('changeUserTier has been removed');
    });

    it('updateStorageTierFromSubscription should throw', async () => {
      await expect(updateStorageTierFromSubscription()).rejects.toThrow('updateStorageTierFromSubscription has been removed');
    });
  });
});
