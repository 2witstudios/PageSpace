import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock shared-redis
vi.mock('../shared-redis', () => ({
  getSharedRedisClient: vi.fn().mockResolvedValue(null),
  isSharedRedisAvailable: vi.fn().mockReturnValue(false),
}));

// Mock logger
vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
  },
}));

import { PageTreeCache } from '../page-tree-cache';

describe('PageTreeCache', () => {
  let cache: PageTreeCache;

  beforeEach(() => {
    vi.useFakeTimers();
    // Reset singleton
    // @ts-expect-error -- accessing private static for test reset
    PageTreeCache.instance = null;
    cache = PageTreeCache.getInstance({ enableRedis: false });
  });

  afterEach(async () => {
    await cache.shutdown();
    vi.useRealTimers();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const cache2 = PageTreeCache.getInstance();
      expect(cache2).toBe(cache);
    });
  });

  describe('getDriveTree / setDriveTree', () => {
    it('should return null for cache miss', async () => {
      const result = await cache.getDriveTree('drive-1');
      expect(result).toBeNull();
    });

    it('should store and retrieve tree from memory', async () => {
      const nodes = [
        { id: 'p1', title: 'Page 1', type: 'document', parentId: null, position: 0 },
      ];

      await cache.setDriveTree('drive-1', 'Test Drive', nodes);
      const result = await cache.getDriveTree('drive-1');

      expect(result).not.toBeNull();
      expect(result!.driveId).toBe('drive-1');
      expect(result!.driveName).toBe('Test Drive');
      expect(result!.nodes).toEqual(nodes);
    });

    it('should return null for expired entries', async () => {
      await cache.setDriveTree('drive-1', 'Test', [], 1); // 1 second TTL

      // Advance past TTL
      vi.advanceTimersByTime(2000);

      const result = await cache.getDriveTree('drive-1');
      expect(result).toBeNull();
    });
  });

  describe('invalidateDriveTree', () => {
    it('should remove tree from memory cache', async () => {
      await cache.setDriveTree('drive-1', 'Test', []);
      await cache.invalidateDriveTree('drive-1');

      const result = await cache.getDriveTree('drive-1');
      expect(result).toBeNull();
    });
  });

  describe('invalidateAllTrees', () => {
    it('should clear all entries', async () => {
      await cache.setDriveTree('drive-1', 'Test 1', []);
      await cache.setDriveTree('drive-2', 'Test 2', []);
      await cache.invalidateAllTrees();

      expect(await cache.getDriveTree('drive-1')).toBeNull();
      expect(await cache.getDriveTree('drive-2')).toBeNull();
    });
  });

  describe('getCacheStats', () => {
    it('should return stats', async () => {
      await cache.setDriveTree('drive-1', 'Test', []);
      const stats = cache.getCacheStats();

      expect(stats.memoryEntries).toBe(1);
      expect(stats.redisAvailable).toBe(false);
      expect(stats.maxMemoryEntries).toBe(500);
      expect(stats.memoryUsagePercent).toBeGreaterThanOrEqual(0);
    });
  });

  describe('clearAll', () => {
    it('should clear all cache entries', async () => {
      await cache.setDriveTree('drive-1', 'Test', []);
      await cache.clearAll();

      expect(cache.getCacheStats().memoryEntries).toBe(0);
    });
  });

  describe('shutdown', () => {
    it('should clean up and reset singleton', async () => {
      await cache.shutdown();
      // @ts-expect-error -- accessing private static for test verification
      expect(PageTreeCache.instance).toBeNull();
    });
  });

  describe('memory cache cleanup', () => {
    it('should clean expired entries on interval', async () => {
      await cache.setDriveTree('drive-1', 'Test', [], 1); // 1s TTL

      // Advance past TTL and cleanup interval (60s)
      vi.advanceTimersByTime(61000);

      const stats = cache.getCacheStats();
      expect(stats.memoryEntries).toBe(0);
    });

    it('should enforce max entries', async () => {
      // Create cache with small max
      await cache.shutdown();
      // @ts-expect-error -- accessing private static for test reset
      PageTreeCache.instance = null;
      cache = PageTreeCache.getInstance({ enableRedis: false, maxMemoryEntries: 2 });

      await cache.setDriveTree('drive-1', 'T1', []);
      await cache.setDriveTree('drive-2', 'T2', []);
      await cache.setDriveTree('drive-3', 'T3', []);

      // Trigger cleanup
      vi.advanceTimersByTime(61000);

      const stats = cache.getCacheStats();
      expect(stats.memoryEntries).toBeLessThanOrEqual(2);
    });
  });
});
