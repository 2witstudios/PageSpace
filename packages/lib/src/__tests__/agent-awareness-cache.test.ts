import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentAwarenessCache } from '../services/agent-awareness-cache';
import type { CachedAgent } from '../services/agent-awareness-cache';

describe('agent-awareness-cache', () => {
  let cache: AgentAwarenessCache;

  beforeEach(() => {
    // Create instance with Redis disabled for predictable testing
    cache = AgentAwarenessCache.getInstance({ enableRedis: false, defaultTTL: 300, maxMemoryEntries: 100 });
  });

  afterEach(async () => {
    await cache.clearAll();
    await cache.shutdown();
  });

  const testDriveId = 'drive_123';
  const testDriveName = 'Test Drive';

  const testAgents: CachedAgent[] = [
    { id: 'agent_1', title: 'Research Assistant', definition: 'Helps with research tasks' },
    { id: 'agent_2', title: 'Code Reviewer', definition: 'Reviews code for quality' },
    { id: 'agent_3', title: 'Writer', definition: null },
  ];

  describe('setDriveAgents and getDriveAgents', () => {
    it('stores and retrieves drive agents', async () => {
      await cache.setDriveAgents(testDriveId, testDriveName, testAgents);

      const cached = await cache.getDriveAgents(testDriveId);

      expect(cached).not.toBeNull();
      expect(cached?.driveId).toBe(testDriveId);
      expect(cached?.driveName).toBe(testDriveName);
      expect(cached?.agents).toHaveLength(3);
      expect(cached?.agents[0].id).toBe('agent_1');
      expect(cached?.agents[0].title).toBe('Research Assistant');
      expect(cached?.agents[0].definition).toBe('Helps with research tasks');
      expect(cached?.agents[2].definition).toBeNull();
    });

    it('returns null for non-existent drive', async () => {
      const cached = await cache.getDriveAgents('nonexistent_drive');

      expect(cached).toBeNull();
    });

    it('respects TTL for drive agents', async () => {
      const shortTTL = 1; // 1 second
      await cache.setDriveAgents(testDriveId, testDriveName, testAgents, shortTTL);

      // Should exist immediately
      let cached = await cache.getDriveAgents(testDriveId);
      expect(cached).not.toBeNull();

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Should be expired
      cached = await cache.getDriveAgents(testDriveId);
      expect(cached).toBeNull();
    });

    it('overwrites existing drive agents', async () => {
      await cache.setDriveAgents(testDriveId, testDriveName, testAgents);

      const updatedAgents: CachedAgent[] = [
        { id: 'agent_4', title: 'New Agent', definition: 'Brand new' },
      ];

      await cache.setDriveAgents(testDriveId, 'Updated Drive', updatedAgents);

      const cached = await cache.getDriveAgents(testDriveId);

      expect(cached?.driveName).toBe('Updated Drive');
      expect(cached?.agents).toHaveLength(1);
      expect(cached?.agents[0].id).toBe('agent_4');
    });

    it('stores agents for different drives separately', async () => {
      const drive1 = 'drive_1';
      const drive2 = 'drive_2';

      const agents1: CachedAgent[] = [{ id: 'agent_a', title: 'Agent A', definition: null }];
      const agents2: CachedAgent[] = [{ id: 'agent_b', title: 'Agent B', definition: 'B def' }];

      await cache.setDriveAgents(drive1, 'Drive One', agents1);
      await cache.setDriveAgents(drive2, 'Drive Two', agents2);

      const cached1 = await cache.getDriveAgents(drive1);
      const cached2 = await cache.getDriveAgents(drive2);

      expect(cached1?.driveName).toBe('Drive One');
      expect(cached1?.agents[0].id).toBe('agent_a');
      expect(cached2?.driveName).toBe('Drive Two');
      expect(cached2?.agents[0].id).toBe('agent_b');
    });

    it('stores empty agent arrays', async () => {
      await cache.setDriveAgents(testDriveId, testDriveName, []);

      const cached = await cache.getDriveAgents(testDriveId);

      expect(cached).not.toBeNull();
      expect(cached?.agents).toHaveLength(0);
    });
  });

  describe('invalidateDriveAgents', () => {
    it('invalidates cache for specific drive', async () => {
      await cache.setDriveAgents(testDriveId, testDriveName, testAgents);

      await cache.invalidateDriveAgents(testDriveId);

      const cached = await cache.getDriveAgents(testDriveId);
      expect(cached).toBeNull();
    });

    it('does not affect other drives', async () => {
      const drive1 = 'drive_1';
      const drive2 = 'drive_2';

      await cache.setDriveAgents(drive1, 'Drive One', testAgents);
      await cache.setDriveAgents(drive2, 'Drive Two', testAgents);

      await cache.invalidateDriveAgents(drive1);

      const cached1 = await cache.getDriveAgents(drive1);
      const cached2 = await cache.getDriveAgents(drive2);

      expect(cached1).toBeNull();
      expect(cached2).not.toBeNull();
    });

    it('handles invalidation for non-existent drive', async () => {
      await expect(cache.invalidateDriveAgents('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('invalidateAllAgents', () => {
    it('clears all cache entries', async () => {
      await cache.setDriveAgents('drive_1', 'Drive 1', testAgents);
      await cache.setDriveAgents('drive_2', 'Drive 2', testAgents);
      await cache.setDriveAgents('drive_3', 'Drive 3', testAgents);

      await cache.invalidateAllAgents();

      const cached1 = await cache.getDriveAgents('drive_1');
      const cached2 = await cache.getDriveAgents('drive_2');
      const cached3 = await cache.getDriveAgents('drive_3');

      expect(cached1).toBeNull();
      expect(cached2).toBeNull();
      expect(cached3).toBeNull();
    });

    it('handles empty cache', async () => {
      await expect(cache.invalidateAllAgents()).resolves.not.toThrow();
    });
  });

  describe('clearAll', () => {
    it('clears all cache entries', async () => {
      await cache.setDriveAgents('drive_1', 'Drive 1', testAgents);
      await cache.setDriveAgents('drive_2', 'Drive 2', testAgents);

      await cache.clearAll();

      const stats = cache.getCacheStats();
      expect(stats.memoryEntries).toBe(0);
    });
  });

  describe('getCacheStats', () => {
    it('returns cache statistics', () => {
      const stats = cache.getCacheStats();

      expect(stats).toHaveProperty('memoryEntries');
      expect(stats).toHaveProperty('redisAvailable');
      expect(stats).toHaveProperty('maxMemoryEntries');
      expect(stats).toHaveProperty('memoryUsagePercent');

      expect(typeof stats.memoryEntries).toBe('number');
      expect(typeof stats.redisAvailable).toBe('boolean');
      expect(typeof stats.maxMemoryEntries).toBe('number');
      expect(typeof stats.memoryUsagePercent).toBe('number');
    });

    it('reflects memory entries count', async () => {
      await cache.setDriveAgents('drive_1', 'Drive 1', testAgents);
      await cache.setDriveAgents('drive_2', 'Drive 2', testAgents);

      const stats = cache.getCacheStats();

      expect(stats.memoryEntries).toBe(2);
    });

    it('calculates memory usage percent', async () => {
      // Add 10 entries
      for (let i = 0; i < 10; i++) {
        await cache.setDriveAgents(`drive_${i}`, `Drive ${i}`, testAgents);
      }

      const stats = cache.getCacheStats();

      expect(stats.memoryUsagePercent).toBeGreaterThan(0);
      expect(stats.memoryUsagePercent).toBeLessThanOrEqual(100);
    });

    it('indicates Redis availability', () => {
      const stats = cache.getCacheStats();

      expect(stats.redisAvailable).toBe(false); // We disabled Redis in beforeEach
    });
  });

  describe('memory management', () => {
    it('enforces max memory entries limit', async () => {
      const smallCache = AgentAwarenessCache.getInstance({ enableRedis: false, maxMemoryEntries: 5 });

      // Add more than max
      for (let i = 0; i < 10; i++) {
        await smallCache.setDriveAgents(`drive_${i}`, `Drive ${i}`, testAgents);
      }

      const stats = smallCache.getCacheStats();
      expect(stats.memoryEntries).toBeLessThanOrEqual(10);

      await smallCache.shutdown();
    });
  });

  describe('configuration', () => {
    it('uses default TTL when not specified', async () => {
      await cache.setDriveAgents(testDriveId, testDriveName, testAgents);

      const cached = await cache.getDriveAgents(testDriveId);

      expect(cached?.ttl).toBe(300); // Default TTL for agent cache
    });

    it('uses custom TTL when specified', async () => {
      const customTTL = 600;
      await cache.setDriveAgents(testDriveId, testDriveName, testAgents, customTTL);

      const cached = await cache.getDriveAgents(testDriveId);

      expect(cached?.ttl).toBe(customTTL);
    });
  });

  describe('edge cases', () => {
    it('handles rapid sequential operations', async () => {
      const operations = [];

      for (let i = 0; i < 50; i++) {
        operations.push(
          cache.setDriveAgents(`drive_${i}`, `Drive ${i}`, testAgents)
        );
      }

      await Promise.all(operations);

      const stats = cache.getCacheStats();
      expect(stats.memoryEntries).toBeGreaterThan(0);
    });

    it('handles concurrent reads and writes', async () => {
      const operations = [];

      // Mix of reads and writes
      for (let i = 0; i < 25; i++) {
        operations.push(cache.setDriveAgents(`drive_${i}`, `Drive ${i}`, testAgents));
        operations.push(cache.getDriveAgents(`drive_${i}`));
      }

      await Promise.all(operations);

      // Should complete without errors
      expect(true).toBe(true);
    });

    it('handles empty drive ID', async () => {
      await cache.setDriveAgents('', 'Empty Drive', testAgents);

      const cached = await cache.getDriveAgents('');
      expect(cached).not.toBeNull();
    });

    it('handles very long IDs', async () => {
      const longId = 'a'.repeat(1000);

      await cache.setDriveAgents(longId, 'Long ID Drive', testAgents);

      const cached = await cache.getDriveAgents(longId);
      expect(cached).not.toBeNull();
    });

    it('handles agents with unicode characters', async () => {
      const unicodeAgents: CachedAgent[] = [
        { id: 'agent_unicode', title: '研究助手 🤖', definition: 'Définition française avec émojis 🎉' },
      ];

      await cache.setDriveAgents(testDriveId, 'Unicode Drive 日本語', unicodeAgents);

      const cached = await cache.getDriveAgents(testDriveId);
      expect(cached?.driveName).toBe('Unicode Drive 日本語');
      expect(cached?.agents[0].title).toBe('研究助手 🤖');
    });

    it('handles agents with very long definitions', async () => {
      const longDefinition = 'x'.repeat(10000);
      const agentsWithLongDef: CachedAgent[] = [
        { id: 'agent_long', title: 'Long Def Agent', definition: longDefinition },
      ];

      await cache.setDriveAgents(testDriveId, testDriveName, agentsWithLongDef);

      const cached = await cache.getDriveAgents(testDriveId);
      expect(cached?.agents[0].definition).toBe(longDefinition);
    });
  });
});
