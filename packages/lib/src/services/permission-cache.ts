import Redis from 'ioredis';
import { loggers } from '../logging/logger-config';

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
  private isRedisAvailable = false;

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
   * Initialize Redis connection with graceful fallback
   */
  private async initializeRedis(): Promise<void> {
    if (!this.config.enableRedis) return;

    try {
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) {
        loggers.api.warn('REDIS_URL not configured, using memory-only cache');
        return;
      }

      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
        connectTimeout: 5000,
        commandTimeout: 3000,
      });

      this.redis.on('connect', () => {
        this.isRedisAvailable = true;
        loggers.api.info('Redis connected for permission caching');
      });

      this.redis.on('error', (error: Error) => {
        this.isRedisAvailable = false;
        loggers.api.warn('Redis connection error, falling back to memory cache', error);
      });

      this.redis.on('close', () => {
        this.isRedisAvailable = false;
        loggers.api.warn('Redis connection closed, using memory cache only');
      });

      // Test connection
      await this.redis.ping();
      this.isRedisAvailable = true;

    } catch (error) {
      loggers.api.warn('Failed to initialize Redis, using memory-only cache', {
        error: error instanceof Error ? error.message : String(error)
      });
      this.redis = null;
      this.isRedisAvailable = false;
    }
  }

  /**
   * Cleanup expired entries from memory cache
   */
  private startMemoryCacheCleanup(): void {
    setInterval(() => {
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

      if (cleanedCount > 0) {
        loggers.api.debug(`Cleaned ${cleanedCount} expired permission cache entries`);
      }
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
    if (memoryResult && Date.now() < memoryResult.cachedAt + (memoryResult.ttl * 1000)) {
      return memoryResult;
    }

    // L2: Check Redis cache
    if (this.isRedisAvailable && this.redis) {
      try {
        const redisResult = await this.redis.get(key);
        if (redisResult) {
          const parsed = JSON.parse(redisResult) as CachedPermission;

          // Promote to L1 cache
          this.memoryCache.set(key, parsed);
          return parsed;
        }
      } catch (error) {
        loggers.api.warn('Redis get error, using memory cache only', { key, error });
      }
    }

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

    // Store in L2 (Redis)
    if (this.isRedisAvailable && this.redis) {
      try {
        await this.redis.setex(key, ttl, JSON.stringify(cached));
      } catch (error) {
        loggers.api.warn('Redis set error, continuing with memory cache', { key, error });
      }
    }
  }

  /**
   * Get drive access from cache
   */
  async getDriveAccess(userId: string, driveId: string): Promise<DriveAccess | null> {
    const key = this.getDriveAccessKey(userId, driveId);

    // L1: Check memory cache first
    const memoryResult = this.memoryCache.get(key) as DriveAccess;
    if (memoryResult && Date.now() < memoryResult.cachedAt + (memoryResult.ttl * 1000)) {
      return memoryResult;
    }

    // L2: Check Redis cache
    if (this.isRedisAvailable && this.redis) {
      try {
        const redisResult = await this.redis.get(key);
        if (redisResult) {
          const parsed = JSON.parse(redisResult) as DriveAccess;

          // Promote to L1 cache
          this.memoryCache.set(key, parsed);
          return parsed;
        }
      } catch (error) {
        loggers.api.warn('Redis get error for drive access', { key, error });
      }
    }

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

    // Store in L2 (Redis)
    if (this.isRedisAvailable && this.redis) {
      try {
        await this.redis.setex(key, ttl, JSON.stringify(cached));
      } catch (error) {
        loggers.api.warn('Redis set error for drive access', { key, error });
      }
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
      } else {
        uncachedPageIds.push(pageId);
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
        loggers.api.warn('Redis invalidation error', { userId, error });
      }
    }

    loggers.api.debug(`Invalidated permission cache for user ${userId}`);
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
        loggers.api.warn('Redis drive invalidation error', { driveId, error });
      }
    }

    loggers.api.debug(`Invalidated permission cache for drive ${driveId}`);
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    memoryEntries: number;
    redisAvailable: boolean;
    maxMemoryEntries: number;
    memoryUsagePercent: number;
  } {
    return {
      memoryEntries: this.memoryCache.size,
      redisAvailable: this.isRedisAvailable,
      maxMemoryEntries: this.config.maxMemoryEntries,
      memoryUsagePercent: Math.round((this.memoryCache.size / this.config.maxMemoryEntries) * 100)
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
        loggers.api.warn('Redis clear all error', { error });
      }
    }

    loggers.api.info('Cleared all permission cache entries');
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
    this.memoryCache.clear();
    PermissionCache.instance = null;
  }
}

// Export singleton instance
export const permissionCache = PermissionCache.getInstance();