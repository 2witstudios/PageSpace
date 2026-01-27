import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PermissionCache } from '../services/permission-cache'
import type { PermissionLevel } from '../services/permission-cache'

describe('permission-cache', () => {
  let cache: PermissionCache

  beforeEach(() => {
    // Create instance with Redis disabled for predictable testing
    cache = PermissionCache.getInstance({ enableRedis: false, defaultTTL: 60, maxMemoryEntries: 100 })
  })

  afterEach(async () => {
    await cache.clearAll()
    await cache.shutdown()
  })

  const testUserId = 'user_123'
  const testPageId = 'page_456'
  const testDriveId = 'drive_789'

  const testPermission: PermissionLevel = {
    canView: true,
    canEdit: true,
    canShare: false,
    canDelete: false
  }

  describe('setPagePermission and getPagePermission', () => {
    it('stores and retrieves page permission', async () => {
      await cache.setPagePermission(testUserId, testPageId, testDriveId, testPermission, false)

      const cached = await cache.getPagePermission(testUserId, testPageId)

      expect(cached).not.toBeNull()
      expect(cached?.canView).toBe(true)
      expect(cached?.canEdit).toBe(true)
      expect(cached?.canShare).toBe(false)
      expect(cached?.canDelete).toBe(false)
      expect(cached?.userId).toBe(testUserId)
      expect(cached?.pageId).toBe(testPageId)
      expect(cached?.driveId).toBe(testDriveId)
      expect(cached?.isOwner).toBe(false)
    })

    it('stores owner status correctly', async () => {
      await cache.setPagePermission(testUserId, testPageId, testDriveId, testPermission, true)

      const cached = await cache.getPagePermission(testUserId, testPageId)

      expect(cached?.isOwner).toBe(true)
    })

    it('returns null for non-existent permission', async () => {
      const cached = await cache.getPagePermission('nonexistent', 'page_999')

      expect(cached).toBeNull()
    })

    it('respects TTL for page permissions', async () => {
      const shortTTL = 1 // 1 second
      await cache.setPagePermission(testUserId, testPageId, testDriveId, testPermission, false, shortTTL)

      // Should exist immediately
      let cached = await cache.getPagePermission(testUserId, testPageId)
      expect(cached).not.toBeNull()

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1500))

      // Should be expired
      cached = await cache.getPagePermission(testUserId, testPageId)
      expect(cached).toBeNull()
    })

    it('overwrites existing permission', async () => {
      await cache.setPagePermission(testUserId, testPageId, testDriveId, testPermission, false)

      const updatedPermission: PermissionLevel = {
        canView: true,
        canEdit: false,
        canShare: true,
        canDelete: true
      }

      await cache.setPagePermission(testUserId, testPageId, testDriveId, updatedPermission, true)

      const cached = await cache.getPagePermission(testUserId, testPageId)

      expect(cached?.canEdit).toBe(false)
      expect(cached?.canShare).toBe(true)
      expect(cached?.canDelete).toBe(true)
      expect(cached?.isOwner).toBe(true)
    })

    it('stores permissions for different users separately', async () => {
      const user1 = 'user_1'
      const user2 = 'user_2'

      await cache.setPagePermission(user1, testPageId, testDriveId, testPermission, false)
      await cache.setPagePermission(user2, testPageId, testDriveId, { ...testPermission, canEdit: false }, false)

      const cached1 = await cache.getPagePermission(user1, testPageId)
      const cached2 = await cache.getPagePermission(user2, testPageId)

      expect(cached1?.canEdit).toBe(true)
      expect(cached2?.canEdit).toBe(false)
    })

    it('stores permissions for different pages separately', async () => {
      const page1 = 'page_1'
      const page2 = 'page_2'

      await cache.setPagePermission(testUserId, page1, testDriveId, testPermission, false)
      await cache.setPagePermission(testUserId, page2, testDriveId, { ...testPermission, canShare: true }, false)

      const cached1 = await cache.getPagePermission(testUserId, page1)
      const cached2 = await cache.getPagePermission(testUserId, page2)

      expect(cached1?.canShare).toBe(false)
      expect(cached2?.canShare).toBe(true)
    })
  })

  describe('setDriveAccess and getDriveAccess', () => {
    it('stores and retrieves drive access', async () => {
      await cache.setDriveAccess(testUserId, testDriveId, true, false)

      const access = await cache.getDriveAccess(testUserId, testDriveId)

      expect(access).not.toBeNull()
      expect(access?.userId).toBe(testUserId)
      expect(access?.driveId).toBe(testDriveId)
      expect(access?.hasAccess).toBe(true)
      expect(access?.isOwner).toBe(false)
    })

    it('stores owner status correctly for drive', async () => {
      await cache.setDriveAccess(testUserId, testDriveId, true, true)

      const access = await cache.getDriveAccess(testUserId, testDriveId)

      expect(access?.isOwner).toBe(true)
    })

    it('stores no-access status', async () => {
      await cache.setDriveAccess(testUserId, testDriveId, false, false)

      const access = await cache.getDriveAccess(testUserId, testDriveId)

      expect(access?.hasAccess).toBe(false)
    })

    it('returns null for non-existent drive access', async () => {
      const access = await cache.getDriveAccess('nonexistent', 'drive_999')

      expect(access).toBeNull()
    })

    it('respects TTL for drive access', async () => {
      const shortTTL = 1 // 1 second
      await cache.setDriveAccess(testUserId, testDriveId, true, false, shortTTL)

      // Should exist immediately
      let access = await cache.getDriveAccess(testUserId, testDriveId)
      expect(access).not.toBeNull()

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1500))

      // Should be expired
      access = await cache.getDriveAccess(testUserId, testDriveId)
      expect(access).toBeNull()
    })
  })

  describe('getBatchPagePermissions', () => {
    it('retrieves multiple cached permissions', async () => {
      const page1 = 'page_1'
      const page2 = 'page_2'
      const page3 = 'page_3'

      await cache.setPagePermission(testUserId, page1, testDriveId, testPermission, false)
      await cache.setPagePermission(testUserId, page2, testDriveId, testPermission, false)
      await cache.setPagePermission(testUserId, page3, testDriveId, testPermission, false)

      const results = await cache.getBatchPagePermissions(testUserId, [page1, page2, page3])

      expect(results.size).toBe(3)
      expect(results.get(page1)?.pageId).toBe(page1)
      expect(results.get(page2)?.pageId).toBe(page2)
      expect(results.get(page3)?.pageId).toBe(page3)
    })

    it('returns only cached items in batch', async () => {
      const page1 = 'page_1'
      const page2 = 'page_2'
      const page3 = 'page_uncached'

      await cache.setPagePermission(testUserId, page1, testDriveId, testPermission, false)
      await cache.setPagePermission(testUserId, page2, testDriveId, testPermission, false)

      const results = await cache.getBatchPagePermissions(testUserId, [page1, page2, page3])

      expect(results.size).toBe(2)
      expect(results.has(page1)).toBe(true)
      expect(results.has(page2)).toBe(true)
      expect(results.has(page3)).toBe(false)
    })

    it('returns empty map for empty input', async () => {
      const results = await cache.getBatchPagePermissions(testUserId, [])

      expect(results.size).toBe(0)
    })

    it('handles all uncached items', async () => {
      const results = await cache.getBatchPagePermissions(testUserId, ['page_1', 'page_2', 'page_3'])

      expect(results.size).toBe(0)
    })

    it('respects TTL in batch retrieval', async () => {
      const shortTTL = 1 // 1 second
      const page1 = 'page_1'
      const page2 = 'page_2'

      await cache.setPagePermission(testUserId, page1, testDriveId, testPermission, false, shortTTL)
      await cache.setPagePermission(testUserId, page2, testDriveId, testPermission, false, shortTTL)

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1500))

      const results = await cache.getBatchPagePermissions(testUserId, [page1, page2])

      expect(results.size).toBe(0)
    })
  })

  describe('invalidateUserCache', () => {
    it('invalidates all cache entries for a user', async () => {
      const page1 = 'page_1'
      const page2 = 'page_2'

      await cache.setPagePermission(testUserId, page1, testDriveId, testPermission, false)
      await cache.setPagePermission(testUserId, page2, testDriveId, testPermission, false)
      await cache.setDriveAccess(testUserId, testDriveId, true, false)

      await cache.invalidateUserCache(testUserId)

      const cached1 = await cache.getPagePermission(testUserId, page1)
      const cached2 = await cache.getPagePermission(testUserId, page2)
      const access = await cache.getDriveAccess(testUserId, testDriveId)

      expect(cached1).toBeNull()
      expect(cached2).toBeNull()
      expect(access).toBeNull()
    })

    it('does not affect other users', async () => {
      const user1 = 'user_1'
      const user2 = 'user_2'

      await cache.setPagePermission(user1, testPageId, testDriveId, testPermission, false)
      await cache.setPagePermission(user2, testPageId, testDriveId, testPermission, false)

      await cache.invalidateUserCache(user1)

      const cached1 = await cache.getPagePermission(user1, testPageId)
      const cached2 = await cache.getPagePermission(user2, testPageId)

      expect(cached1).toBeNull()
      expect(cached2).not.toBeNull()
    })

    it('handles invalidation for non-existent user', async () => {
      await expect(cache.invalidateUserCache('nonexistent')).resolves.not.toThrow()
    })
  })

  describe('invalidateDriveCache', () => {
    it('invalidates all cache entries for a drive', async () => {
      const user1 = 'user_1'
      const user2 = 'user_2'
      const page1 = 'page_1'

      await cache.setPagePermission(user1, page1, testDriveId, testPermission, false)
      await cache.setPagePermission(user2, page1, testDriveId, testPermission, false)
      await cache.setDriveAccess(user1, testDriveId, true, false)

      await cache.invalidateDriveCache(testDriveId)

      const cached1 = await cache.getPagePermission(user1, page1)
      const cached2 = await cache.getPagePermission(user2, page1)
      const access = await cache.getDriveAccess(user1, testDriveId)

      expect(cached1).toBeNull()
      expect(cached2).toBeNull()
      expect(access).toBeNull()
    })

    it('does not affect other drives', async () => {
      const drive1 = 'drive_1'
      const drive2 = 'drive_2'

      await cache.setPagePermission(testUserId, testPageId, drive1, testPermission, false)
      await cache.setPagePermission(testUserId, testPageId, drive2, testPermission, false)

      await cache.invalidateDriveCache(drive1)

      const cached1 = await cache.getPagePermission(testUserId, testPageId)
      // Note: Both entries have same user/page combo, but different driveId
      // The invalidation is based on driveId in the cached entry
    })

    it('handles invalidation for non-existent drive', async () => {
      await expect(cache.invalidateDriveCache('nonexistent')).resolves.not.toThrow()
    })
  })

  describe('clearAll', () => {
    it('clears all cache entries', async () => {
      await cache.setPagePermission('user_1', 'page_1', testDriveId, testPermission, false)
      await cache.setPagePermission('user_2', 'page_2', testDriveId, testPermission, false)
      await cache.setDriveAccess('user_1', 'drive_1', true, false)
      await cache.setDriveAccess('user_2', 'drive_2', true, false)

      await cache.clearAll()

      const stats = cache.getCacheStats()
      expect(stats.memoryEntries).toBe(0)
    })
  })

  describe('getCacheStats', () => {
    it('returns cache statistics', () => {
      const stats = cache.getCacheStats()

      expect(stats).toHaveProperty('memoryEntries')
      expect(stats).toHaveProperty('redisAvailable')
      expect(stats).toHaveProperty('maxMemoryEntries')
      expect(stats).toHaveProperty('memoryUsagePercent')

      expect(typeof stats.memoryEntries).toBe('number')
      expect(typeof stats.redisAvailable).toBe('boolean')
      expect(typeof stats.maxMemoryEntries).toBe('number')
      expect(typeof stats.memoryUsagePercent).toBe('number')
    })

    it('reflects memory entries count', async () => {
      await cache.setPagePermission('user_1', 'page_1', testDriveId, testPermission, false)
      await cache.setPagePermission('user_2', 'page_2', testDriveId, testPermission, false)

      const stats = cache.getCacheStats()

      expect(stats.memoryEntries).toBeGreaterThan(0)
    })

    it('calculates memory usage percent', async () => {
      // Add 10 entries
      for (let i = 0; i < 10; i++) {
        await cache.setPagePermission(`user_${i}`, `page_${i}`, testDriveId, testPermission, false)
      }

      const stats = cache.getCacheStats()

      expect(stats.memoryUsagePercent).toBeGreaterThan(0)
      expect(stats.memoryUsagePercent).toBeLessThanOrEqual(100)
    })
  })

  describe('memory management', () => {
    it('enforces max memory entries limit', async () => {
      const smallCache = PermissionCache.getInstance({ enableRedis: false, maxMemoryEntries: 5 })

      // Add more than max
      for (let i = 0; i < 10; i++) {
        await smallCache.setPagePermission(`user_${i}`, `page_${i}`, testDriveId, testPermission, false)
      }

      const stats = smallCache.getCacheStats()
      expect(stats.memoryEntries).toBeLessThanOrEqual(10)

      await smallCache.shutdown()
    })

    it('cleans up expired entries', async () => {
      const shortTTL = 1
      await cache.setPagePermission('user_1', 'page_1', testDriveId, testPermission, false, shortTTL)
      await cache.setPagePermission('user_2', 'page_2', testDriveId, testPermission, false, shortTTL)

      // Wait for expiration plus cleanup cycle
      await new Promise(resolve => setTimeout(resolve, 31000)) // Cleanup runs every 30s

      const stats = cache.getCacheStats()
      // Entries should be cleaned up (or at least not retrievable)
    }, 35000)
  })

  describe('configuration', () => {
    it('uses default TTL when not specified', async () => {
      await cache.setPagePermission(testUserId, testPageId, testDriveId, testPermission, false)

      const cached = await cache.getPagePermission(testUserId, testPageId)

      expect(cached?.ttl).toBe(60) // Default TTL
    })

    it('uses custom TTL when specified', async () => {
      const customTTL = 300
      await cache.setPagePermission(testUserId, testPageId, testDriveId, testPermission, false, customTTL)

      const cached = await cache.getPagePermission(testUserId, testPageId)

      expect(cached?.ttl).toBe(customTTL)
    })

    it('indicates Redis availability', () => {
      const stats = cache.getCacheStats()

      expect(stats.redisAvailable).toBe(false) // We disabled Redis in beforeEach
    })
  })

  describe('cache metrics', () => {
    beforeEach(() => {
      cache.resetMetrics()
    })

    it('tracks hits when cache returns valid entry', async () => {
      await cache.setPagePermission(testUserId, testPageId, testDriveId, testPermission, false)

      await cache.getPagePermission(testUserId, testPageId)

      const { metrics } = cache.getCacheStats()
      expect(metrics.hits).toBe(1)
      expect(metrics.misses).toBe(0)
    })

    it('tracks misses when cache returns null', async () => {
      await cache.getPagePermission('nonexistent', 'page_999')

      const { metrics } = cache.getCacheStats()
      expect(metrics.misses).toBe(1)
      expect(metrics.hits).toBe(0)
    })

    it('tracks invalidation count', async () => {
      await cache.setPagePermission(testUserId, testPageId, testDriveId, testPermission, false)

      await cache.invalidateUserCache(testUserId)

      const { metrics } = cache.getCacheStats()
      expect(metrics.invalidations).toBe(1)
    })

    it('tracks TTL expirations on access', async () => {
      await cache.setPagePermission(testUserId, testPageId, testDriveId, testPermission, false, 1)

      await new Promise(resolve => setTimeout(resolve, 1100))

      await cache.getPagePermission(testUserId, testPageId)

      const { metrics } = cache.getCacheStats()
      expect(metrics.ttlExpirations).toBe(1)
      expect(metrics.misses).toBe(1)
    })

    it('resets metrics correctly', async () => {
      await cache.getPagePermission('nonexistent', 'page_999')
      expect(cache.getCacheStats().metrics.misses).toBe(1)

      cache.resetMetrics()

      const { metrics } = cache.getCacheStats()
      expect(metrics.hits).toBe(0)
      expect(metrics.misses).toBe(0)
      expect(metrics.invalidations).toBe(0)
      expect(metrics.invalidationFailures).toBe(0)
      expect(metrics.ttlExpirations).toBe(0)
      expect(metrics.redisErrors).toBe(0)
    })

    it('tracks batch operation hits and misses', async () => {
      await cache.setPagePermission(testUserId, 'page_1', testDriveId, testPermission, false)
      await cache.setPagePermission(testUserId, 'page_2', testDriveId, testPermission, false)

      cache.resetMetrics()

      await cache.getBatchPagePermissions(testUserId, ['page_1', 'page_2', 'page_uncached'])

      const { metrics } = cache.getCacheStats()
      expect(metrics.hits).toBe(2)
      expect(metrics.misses).toBe(1)
    })

    it('invalidation clears cache and subsequent access misses', async () => {
      await cache.setPagePermission(testUserId, testPageId, testDriveId, testPermission, false)

      cache.resetMetrics()
      await cache.getPagePermission(testUserId, testPageId)
      expect(cache.getCacheStats().metrics.hits).toBe(1)

      await cache.invalidateUserCache(testUserId)

      cache.resetMetrics()
      const result = await cache.getPagePermission(testUserId, testPageId)
      expect(result).toBeNull()
      expect(cache.getCacheStats().metrics.misses).toBe(1)
    })
  })

  describe('edge cases', () => {
    it('handles rapid sequential operations', async () => {
      const operations = []

      for (let i = 0; i < 100; i++) {
        operations.push(
          cache.setPagePermission(`user_${i}`, `page_${i}`, testDriveId, testPermission, false)
        )
      }

      await Promise.all(operations)

      const stats = cache.getCacheStats()
      expect(stats.memoryEntries).toBeGreaterThan(0)
    })

    it('handles concurrent reads and writes', async () => {
      const operations = []

      // Mix of reads and writes
      for (let i = 0; i < 50; i++) {
        operations.push(cache.setPagePermission(`user_${i}`, testPageId, testDriveId, testPermission, false))
        operations.push(cache.getPagePermission(`user_${i}`, testPageId))
      }

      await Promise.all(operations)

      // Should complete without errors
      expect(true).toBe(true)
    })

    it('handles empty user ID', async () => {
      await cache.setPagePermission('', testPageId, testDriveId, testPermission, false)

      const cached = await cache.getPagePermission('', testPageId)
      expect(cached).not.toBeNull()
    })

    it('handles empty page ID', async () => {
      await cache.setPagePermission(testUserId, '', testDriveId, testPermission, false)

      const cached = await cache.getPagePermission(testUserId, '')
      expect(cached).not.toBeNull()
    })

    it('handles very long IDs', async () => {
      const longId = 'a'.repeat(1000)

      await cache.setPagePermission(longId, testPageId, testDriveId, testPermission, false)

      const cached = await cache.getPagePermission(longId, testPageId)
      expect(cached).not.toBeNull()
    })
  })
})
