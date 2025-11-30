import type Redis from 'ioredis';
import { loggers } from '../logging/logger-config';
import { getSharedRedisClient, isSharedRedisAvailable } from './shared-redis';

/**
 * Cached tree node for page tree context
 */
export interface CachedTreeNode {
  id: string;
  title: string;
  type: string;
  parentId: string | null;
  position: number;
}

/**
 * Cached page tree for a drive
 */
export interface CachedPageTree {
  driveId: string;
  driveName: string;
  nodes: CachedTreeNode[];
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
 * Page Tree Cache Service
 *
 * Caches page tree structures per drive to reduce database queries when building
 * AI system prompts. Uses the same two-tier architecture as AgentAwarenessCache
 * (L1 memory + L2 Redis).
 *
 * Cache key: `pagespace:tree:drive:${driveId}` -> flat array of tree nodes
 *
 * Invalidation triggers:
 * - Page created
 * - Page deleted/trashed
 * - Page moved (parentId change)
 * - Page reordered
 * - Page restored from trash
 * - Page renamed
 *
 * NOT invalidated on:
 * - Content edits (structure unchanged)
 * - AI settings changes
 */
export class PageTreeCache {
  private static instance: PageTreeCache | null = null;

  private redis: Redis | null = null;
  private memoryCache = new Map<string, CachedPageTree>();
  private config: CacheConfig;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  private constructor(config: Partial<CacheConfig> = {}) {
    this.config = {
      defaultTTL: 300, // 5 minutes - tree structure changes less frequently
      maxMemoryEntries: 500, // Limit memory cache size
      enableRedis: true,
      keyPrefix: 'pagespace:tree:',
      ...config
    };

    this.initializeRedis();
    this.startMemoryCacheCleanup();
  }

  /**
   * Get singleton instance
   */
  static getInstance(config?: Partial<CacheConfig>): PageTreeCache {
    if (!PageTreeCache.instance) {
      PageTreeCache.instance = new PageTreeCache(config);
    }
    return PageTreeCache.instance;
  }

  /**
   * Initialize Redis connection using shared client
   */
  private async initializeRedis(): Promise<void> {
    if (!this.config.enableRedis) return;

    try {
      this.redis = await getSharedRedisClient();
    } catch (error) {
      loggers.api.warn('Failed to get shared Redis client for page tree cache', {
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

      // Enforce size limit
      if (this.memoryCache.size > this.config.maxMemoryEntries) {
        const excess = this.memoryCache.size - this.config.maxMemoryEntries;
        const keysToDelete = Array.from(this.memoryCache.keys()).slice(0, excess);
        keysToDelete.forEach(key => this.memoryCache.delete(key));
        cleanedCount += keysToDelete.length;
      }

      if (cleanedCount > 0) {
        loggers.api.debug(`Cleaned ${cleanedCount} expired page tree cache entries`);
      }
    }, 60000); // Clean every minute
  }

  /**
   * Generate cache key for drive tree
   */
  private getDriveTreeKey(driveId: string): string {
    return `${this.config.keyPrefix}drive:${driveId}`;
  }

  /**
   * Get tree for a drive from cache (L1 memory -> L2 Redis)
   */
  async getDriveTree(driveId: string): Promise<CachedPageTree | null> {
    const key = this.getDriveTreeKey(driveId);

    // L1: Check memory cache first
    const memoryResult = this.memoryCache.get(key);
    if (memoryResult && Date.now() < memoryResult.cachedAt + (memoryResult.ttl * 1000)) {
      return memoryResult;
    }

    // L2: Check Redis cache
    if (this.isRedisAvailable && this.redis) {
      try {
        const redisResult = await this.redis.get(key);
        if (redisResult) {
          const parsed = JSON.parse(redisResult) as CachedPageTree;

          // Promote to L1 cache
          this.memoryCache.set(key, parsed);
          return parsed;
        }
      } catch (error) {
        loggers.api.warn('Redis get error for page tree cache', { key, error });
      }
    }

    return null;
  }

  /**
   * Set tree for a drive in cache (L1 + L2)
   */
  async setDriveTree(
    driveId: string,
    driveName: string,
    nodes: CachedTreeNode[],
    ttl: number = this.config.defaultTTL
  ): Promise<void> {
    const key = this.getDriveTreeKey(driveId);
    const cached: CachedPageTree = {
      driveId,
      driveName,
      nodes,
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
        loggers.api.warn('Redis set error for page tree cache', { key, error });
      }
    }
  }

  /**
   * Invalidate cache for a specific drive
   * Call this when tree structure changes (create, delete, move, reorder)
   */
  async invalidateDriveTree(driveId: string): Promise<void> {
    const key = this.getDriveTreeKey(driveId);

    // Clear from memory cache
    this.memoryCache.delete(key);

    // Clear from Redis cache
    if (this.isRedisAvailable && this.redis) {
      try {
        await this.redis.del(key);
      } catch (error) {
        loggers.api.warn('Redis delete error for page tree cache', { key, error });
      }
    }

    loggers.api.debug(`Invalidated page tree cache for drive ${driveId}`);
  }

  /**
   * Invalidate all tree cache entries
   * Use sparingly - only for edge cases like bulk operations
   */
  async invalidateAllTrees(): Promise<void> {
    // Clear memory cache
    this.memoryCache.clear();

    // Clear Redis cache
    if (this.isRedisAvailable && this.redis) {
      try {
        const pattern = `${this.config.keyPrefix}*`;
        const keys = await this.redis.keys(pattern);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } catch (error) {
        loggers.api.warn('Redis clear all error for page tree cache', { error });
      }
    }

    loggers.api.debug('Invalidated all page tree cache entries');
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
   * Clear all cache entries (use with caution, primarily for testing)
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
        loggers.api.warn('Redis clear all error for page tree cache', { error });
      }
    }

    loggers.api.debug('Cleared all page tree cache entries');
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
    PageTreeCache.instance = null;
  }
}

// Export singleton instance (same pattern as AgentAwarenessCache)
export const pageTreeCache = PageTreeCache.getInstance();
