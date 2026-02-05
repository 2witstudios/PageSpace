import type Redis from 'ioredis';
import { loggers } from '../logging/logger-config';
import { getSharedRedisClient, isSharedRedisAvailable } from './shared-redis';

// Types for permission data
export interface PermissionLevel {
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
}

export interface CachedPermission extends PermissionLevel {
  userId: string;
  pageId: string;
  driveId: string;
  isOwner: boolean;
  cachedAt: number;
  ttl: number;
}

export interface DriveAccess {
  userId: string;
  driveId: string;
  hasAccess: boolean;
  isOwner: boolean;
  cachedAt: number;
  ttl: number;
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  invalidations: number;
  invalidationFailures: number;
  ttlExpirations: number;
  redisErrors: number;
}

// Cache configuration
interface CacheConfig {
  defaultTTL: number; // seconds
  maxMemoryEntries: number;
  enableRedis: boolean;
  keyPrefix: string;
}

/**
 * High-performance permission caching service with hybrid in-memory + Redis architecture
 *
 * Features:
 * - Two-tier caching: in-memory (L1) + Redis (L2)
 * - Batch operations for N+1 query elimination
 * - Automatic TTL and cache invalidation
 * - Graceful degradation when Redis is unavailable
 * - Production-ready error handling and monitoring
 */
export class PermissionCache {
  private static instance: PermissionCache | null = null;

  private redis: Redis | null = null;
  private memoryCache = new Map<string, CachedPermission | DriveAccess>();
  private config: CacheConfig;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private metrics: CacheMetrics = {
    hits: 0,
    misses: 0,
    invalidations: 0,
    invalidationFailures: 0,
    ttlExpirations: 0,
    redisErrors: 0,
  };

  private constructor(config: Partial<CacheConfig> = {}) {
    this.config = {
      defaultTTL: 60, // 1 minute default TTL
      maxMemoryEntries: 1000, // Limit memory cache size
      enableRedis: true,
      keyPrefix: 'pagespace:perms:',
      ...config
    };

    this.initializeRedis();
    this.startMemoryCacheCleanup();
  }

  /**
   * Get singleton instance
   */
  static getInstance(config?: Partial<CacheConfig>): PermissionCache {
    if (!PermissionCache.instance) {
      PermissionCache.instance = new PermissionCache(config);
    }
    return PermissionCache.instance;
  }

  /**
   * Initialize Redis connection using shared client
   */
  private async initializeRedis(): Promise<void> {
    if (!this.config.enableRedis) return;

    try {
      this.redis = await getSharedRedisClient();
    } catch (error) {
      this.metrics.redisErrors++;
      loggers.api.warn('Failed to get shared Redis client for permission cache', {
        error: error instanceof Error ? error.message : String(error)
      });
      this.redis = null;
    }
  }

  /**
   * Check if Redis is available (uses shared state)
   */
  private get isRedisAvailable(): boolean {
    return isSharedRedisAvailable() && this.redis !== null;
  }

  /**
   * Cleanup expired entries from memory cache
   */
  private startMemoryCacheCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      let cleanedCount = 0;

      for (const [key, entry] of this.memoryCache.entries()) {
        if (now > entry.cachedAt + (entry.ttl * 1000)) {
          this.memoryCache.delete(key);
          cleanedCount++;
        }
      }

      // Also enforce size limit
      if (this.memoryCache.size > this.config.maxMemoryEntries) {
        const excess = this.memoryCache.size - this.config.maxMemoryEntries;
        const keysToDelete = Array.from(this.memoryCache.keys()).slice(0, excess);

        keysToDelete.forEach(key => this.memoryCache.delete(key));
        cleanedCount += keysToDelete.length;
      }

      this.metrics.ttlExpirations += cleanedCount;

      const totalRequests = this.metrics.hits + this.metrics.misses;
      const hitRate = totalRequests > 0 ? Math.round((this.metrics.hits / totalRequests) * 100) : 0;
      loggers.performance.debug('Permission cache stats', {
        memoryEntries: this.memoryCache.size,
        hitRate: `${hitRate}%`,
        ...this.metrics,
      });
    }, 30000); // Clean every 30 seconds
  }

  /**
   * Generate cache key for page permissions
   */
  private getPagePermissionKey(userId: string, pageId: string): string {
    return `${this.config.keyPrefix}page:${userId}:${pageId}`;
  }

  /**
   * Generate cache key for drive access
   */
  private getDriveAccessKey(userId: string, driveId: string): string {
    return `${this.config.keyPrefix}drive:${userId}:${driveId}`;
  }

  /**
   * Get permission from cache (L1 memory -> L2 Redis)
   */
  async getPagePermission(userId: string, pageId: string): Promise<CachedPermission | null> {
    const key = this.getPagePermissionKey(userId, pageId);

    // L1: Check memory cache first
    const memoryResult = this.memoryCache.get(key) as CachedPermission;
    if (memoryResult) {
      if (Date.now() < memoryResult.cachedAt + (memoryResult.ttl * 1000)) {
        this.metrics.hits++;
        return memoryResult;
      }
      this.metrics.ttlExpirations++;
      this.memoryCache.delete(key);
    }

    // L2: Check Redis cache
    if (this.isRedisAvailable && this.redis) {
      try {
        const redisResult = await this.redis.get(key);
        if (redisResult) {
          const parsed = JSON.parse(redisResult) as CachedPermission;

          // Promote to L1 cache
          this.memoryCache.set(key, parsed);
          this.metrics.hits++;
          return parsed;
        }
      } catch (error) {
        this.metrics.redisErrors++;
        loggers.api.warn('Redis get error, using memory cache only', { key, error });
      }
    }

    this.metrics.misses++;
    return null;
  }

  /**
   * Set permission in cache (L1 + L2)
   */
  async setPagePermission(
    userId: string,
    pageId: string,
    driveId: string,
    permission: PermissionLevel,
    isOwner: boolean,
    ttl: number = this.config.defaultTTL
  ): Promise<void> {
    const key = this.getPagePermissionKey(userId, pageId);
    const cached: CachedPermission = {
      ...permission,
      userId,
      pageId,
      driveId,
      isOwner,
      cachedAt: Date.now(),
      ttl
    };

    // Store in L1 (memory)
    this.memoryCache.set(key, cached);

    // Store in L2 (Redis) - fire-and-forget since L1 is already updated
    if (this.isRedisAvailable && this.redis) {
      this.redis.setex(key, ttl, JSON.stringify(cached)).catch((error) => {
        this.metrics.redisErrors++;
        loggers.api.warn('Redis set error, continuing with memory cache', { key, error });
      });
    }
  }

  /**
   * Get drive access from cache
   */
  async getDriveAccess(userId: string, driveId: string): Promise<DriveAccess | null> {
    const key = this.getDriveAccessKey(userId, driveId);

    // L1: Check memory cache first
    const memoryResult = this.memoryCache.get(key) as DriveAccess;
    if (memoryResult) {
      if (Date.now() < memoryResult.cachedAt + (memoryResult.ttl * 1000)) {
        this.metrics.hits++;
        return memoryResult;
      }
      this.metrics.ttlExpirations++;
      this.memoryCache.delete(key);
    }

    // L2: Check Redis cache
    if (this.isRedisAvailable && this.redis) {
      try {
        const redisResult = await this.redis.get(key);
        if (redisResult) {
          const parsed = JSON.parse(redisResult) as DriveAccess;

          // Promote to L1 cache
          this.memoryCache.set(key, parsed);
          this.metrics.hits++;
          return parsed;
        }
      } catch (error) {
        this.metrics.redisErrors++;
        loggers.api.warn('Redis get error for drive access', { key, error });
      }
    }

    this.metrics.misses++;
    return null;
  }

  /**
   * Set drive access in cache
   */
  async setDriveAccess(
    userId: string,
    driveId: string,
    hasAccess: boolean,
    isOwner: boolean,
    ttl: number = this.config.defaultTTL
  ): Promise<void> {
    const key = this.getDriveAccessKey(userId, driveId);
    const cached: DriveAccess = {
      userId,
      driveId,
      hasAccess,
      isOwner,
      cachedAt: Date.now(),
      ttl
    };

    // Store in L1 (memory)
    this.memoryCache.set(key, cached);

    // Store in L2 (Redis) - fire-and-forget since L1 is already updated
    if (this.isRedisAvailable && this.redis) {
      this.redis.setex(key, ttl, JSON.stringify(cached)).catch((error) => {
        this.metrics.redisErrors++;
        loggers.api.warn('Redis set error for drive access', { key, error });
      });
    }
  }

  /**
   * Batch get permissions for multiple pages
   */
  async getBatchPagePermissions(userId: string, pageIds: string[]): Promise<Map<string, CachedPermission>> {
    const results = new Map<string, CachedPermission>();
    const uncachedPageIds: string[] = [];

    // Check L1 cache for all pageIds
    for (const pageId of pageIds) {
      const key = this.getPagePermissionKey(userId, pageId);
      const cached = this.memoryCache.get(key) as CachedPermission;

      if (cached && Date.now() < cached.cachedAt + (cached.ttl * 1000)) {
        results.set(pageId, cached);
        this.metrics.hits++;
      } else {
        uncachedPageIds.push(pageId);
        this.metrics.misses++;
      }
    }

    // Check L2 cache (Redis) for uncached items
    if (uncachedPageIds.length > 0 && this.isRedisAvailable && this.redis) {
      try {
        const keys = uncachedPageIds.map(pageId => this.getPagePermissionKey(userId, pageId));
        const redisResults = await this.redis.mget(...keys);

        for (let i = 0; i < redisResults.length; i++) {
          const result = redisResults[i];
          if (result) {
            const parsed = JSON.parse(result) as CachedPermission;
            results.set(uncachedPageIds[i], parsed);

            // Promote to L1
            this.memoryCache.set(keys[i], parsed);
          }
        }
      } catch (error) {
        this.metrics.redisErrors++;
        loggers.api.warn('Redis mget error for batch permissions', { error });
      }
    }

    return results;
  }

  /**
   * Invalidate cache entries for a user
   */
  async invalidateUserCache(userId: string): Promise<void> {
    // Clear from memory cache
    const keysToDelete: string[] = [];
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.userId === userId) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(key => this.memoryCache.delete(key));

    // Clear from Redis cache
    if (this.isRedisAvailable && this.redis) {
      try {
        const pattern = `${this.config.keyPrefix}*:${userId}:*`;
        const keys = await this.redis.keys(pattern);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } catch (error) {
        this.metrics.invalidationFailures++;
        this.metrics.redisErrors++;
        loggers.api.warn('Redis invalidation error', { userId, error });
        return;
      }
    }

    this.metrics.invalidations++;
    loggers.api.debug(`Invalidated permission cache for user ${userId}`, { entriesCleared: keysToDelete.length });
  }

  /**
   * Invalidate cache entries for a drive
   */
  async invalidateDriveCache(driveId: string): Promise<void> {
    // Clear from memory cache
    const keysToDelete: string[] = [];
    for (const [key, entry] of this.memoryCache.entries()) {
      if ('driveId' in entry && entry.driveId === driveId) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(key => this.memoryCache.delete(key));

    // Clear from Redis cache
    if (this.isRedisAvailable && this.redis) {
      try {
        const patterns = [
          `${this.config.keyPrefix}page:*:*`, // Will need to filter by driveId
          `${this.config.keyPrefix}drive:*:${driveId}`
        ];

        for (const pattern of patterns) {
          const keys = await this.redis.keys(pattern);
          if (keys.length > 0) {
            // For page permissions, we need to check driveId in the value
            if (pattern.includes('page:')) {
              const values = await this.redis.mget(...keys);
              const keysToDelete = keys.filter((key: string, index: number) => {
                const value = values[index];
                if (value) {
                  try {
                    const parsed = JSON.parse(value) as CachedPermission;
                    return parsed.driveId === driveId;
                  } catch {
                    return false;
                  }
                }
                return false;
              });

              if (keysToDelete.length > 0) {
                await this.redis.del(...keysToDelete);
              }
            } else {
              await this.redis.del(...keys);
            }
          }
        }
      } catch (error) {
        this.metrics.invalidationFailures++;
        this.metrics.redisErrors++;
        loggers.api.warn('Redis drive invalidation error', { driveId, error });
        return;
      }
    }

    this.metrics.invalidations++;
    loggers.api.debug(`Invalidated permission cache for drive ${driveId}`, { entriesCleared: keysToDelete.length });
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    memoryEntries: number;
    redisAvailable: boolean;
    maxMemoryEntries: number;
    memoryUsagePercent: number;
    metrics: CacheMetrics;
  } {
    return {
      memoryEntries: this.memoryCache.size,
      redisAvailable: this.isRedisAvailable,
      maxMemoryEntries: this.config.maxMemoryEntries,
      memoryUsagePercent: Math.round((this.memoryCache.size / this.config.maxMemoryEntries) * 100),
      metrics: { ...this.metrics },
    };
  }

  resetMetrics(): void {
    this.metrics = {
      hits: 0,
      misses: 0,
      invalidations: 0,
      invalidationFailures: 0,
      ttlExpirations: 0,
      redisErrors: 0,
    };
  }

  /**
   * Clear all cache entries (use with caution)
   */
  async clearAll(): Promise<void> {
    this.memoryCache.clear();

    if (this.isRedisAvailable && this.redis) {
      try {
        const keys = await this.redis.keys(`${this.config.keyPrefix}*`);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } catch (error) {
        this.metrics.redisErrors++;
        loggers.api.warn('Redis clear all error', { error });
      }
    }

    loggers.api.info('Cleared all permission cache entries');
  }

  /**
   * Graceful shutdown
   * Note: Does not close the shared Redis connection - that's managed by shared-redis.ts
   */
  async shutdown(): Promise<void> {
    // Clear cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Just null out our reference - shared Redis is managed separately
    this.redis = null;
    this.memoryCache.clear();
    PermissionCache.instance = null;
  }
}

// Export singleton instance
export const permissionCache = PermissionCache.getInstance();