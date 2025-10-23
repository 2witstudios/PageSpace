import Redis from 'ioredis';
import { loggers } from '../logger-config';
import type { AggregatedCalendarResult } from './calendar-aggregation';

// Cache configuration
interface CacheConfig {
  defaultTTL: number; // seconds
  maxMemoryEntries: number;
  enableRedis: boolean;
  keyPrefix: string;
}

// Cached calendar data interface
export interface CachedCalendarData {
  pageId: string;
  userId?: string; // For personal calendars
  startDate?: string;
  endDate?: string;
  data: AggregatedCalendarResult;
  cachedAt: number;
  ttl: number;
}

/**
 * High-performance calendar caching service with hybrid in-memory + Redis architecture
 *
 * Features:
 * - Two-tier caching: in-memory (L1) + Redis (L2)
 * - Automatic TTL and cache invalidation
 * - Graceful degradation when Redis is unavailable
 * - Date-range aware caching
 * - Production-ready error handling
 */
export class CalendarCache {
  private static instance: CalendarCache | null = null;

  private redis: Redis | null = null;
  private memoryCache = new Map<string, CachedCalendarData>();
  private config: CacheConfig;
  private isRedisAvailable = false;
  private cleanupInterval: NodeJS.Timeout | null = null;

  private constructor(config: Partial<CacheConfig> = {}) {
    this.config = {
      defaultTTL: 300, // 5 minutes default TTL for calendar data
      maxMemoryEntries: 1000,
      enableRedis: true,
      keyPrefix: 'pagespace:calendar:',
      ...config
    };

    this.initializeRedis();
    this.startMemoryCacheCleanup();
  }

  /**
   * Get singleton instance
   */
  static getInstance(config?: Partial<CacheConfig>): CalendarCache {
    if (!CalendarCache.instance) {
      CalendarCache.instance = new CalendarCache(config);
    }
    return CalendarCache.instance;
  }

  /**
   * Initialize Redis connection with graceful fallback
   */
  private async initializeRedis(): Promise<void> {
    if (!this.config.enableRedis) return;

    try {
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) {
        loggers.api.warn('REDIS_URL not configured, using memory-only cache for calendars');
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
        loggers.api.info('Calendar cache connected to Redis');
      });

      this.redis.on('error', (error: Error) => {
        this.isRedisAvailable = false;
        loggers.api.error('Calendar cache Redis error:', error);
      });

      await this.redis.connect();
    } catch (error) {
      loggers.api.error('Calendar cache failed to initialize Redis:', error);
      this.isRedisAvailable = false;
    }
  }

  /**
   * Start periodic cleanup of expired memory cache entries
   */
  private startMemoryCacheCleanup(): void {
    // Clean up every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredMemoryEntries();
    }, 60000);

    // Don't prevent process from exiting
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Remove expired entries from memory cache
   */
  private cleanupExpiredMemoryEntries(): void {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.memoryCache.entries()) {
      const age = (now - entry.cachedAt) / 1000;
      if (age > entry.ttl) {
        this.memoryCache.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      loggers.api.debug(`Calendar cache cleaned up ${removed} expired memory entries`);
    }

    // Enforce max size with LRU eviction
    if (this.memoryCache.size > this.config.maxMemoryEntries) {
      const entriesToRemove = this.memoryCache.size - this.config.maxMemoryEntries;
      const keys = Array.from(this.memoryCache.keys());

      // Remove oldest entries
      for (let i = 0; i < entriesToRemove; i++) {
        this.memoryCache.delete(keys[i]);
      }

      loggers.api.debug(`Calendar cache evicted ${entriesToRemove} entries due to size limit`);
    }
  }

  /**
   * Generate cache key for calendar events
   */
  private getCacheKey(pageId: string, startDate?: string, endDate?: string): string {
    const dateRange = startDate && endDate ? `:${startDate}:${endDate}` : '';
    return `${this.config.keyPrefix}${pageId}${dateRange}`;
  }

  /**
   * Generate cache key for personal calendar
   */
  private getPersonalCacheKey(userId: string, startDate?: string, endDate?: string): string {
    const dateRange = startDate && endDate ? `:${startDate}:${endDate}` : '';
    return `${this.config.keyPrefix}personal:${userId}${dateRange}`;
  }

  /**
   * Get cached calendar events
   */
  async getCachedEvents(
    pageId: string,
    startDate?: string,
    endDate?: string
  ): Promise<AggregatedCalendarResult | null> {
    const key = this.getCacheKey(pageId, startDate, endDate);

    // Try L1 cache (memory) first
    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry) {
      const age = (Date.now() - memoryEntry.cachedAt) / 1000;
      if (age <= memoryEntry.ttl) {
        loggers.api.debug(`Calendar cache hit (L1): ${key}`);
        return memoryEntry.data;
      } else {
        // Expired, remove from memory
        this.memoryCache.delete(key);
      }
    }

    // Try L2 cache (Redis)
    if (this.isRedisAvailable && this.redis) {
      try {
        const cached = await this.redis.get(key);
        if (cached) {
          const parsed: CachedCalendarData = JSON.parse(cached);
          const age = (Date.now() - parsed.cachedAt) / 1000;

          if (age <= parsed.ttl) {
            // Promote to L1 cache
            this.memoryCache.set(key, parsed);
            loggers.api.debug(`Calendar cache hit (L2): ${key}`);
            return parsed.data;
          } else {
            // Expired, remove from Redis
            await this.redis.del(key);
          }
        }
      } catch (error) {
        loggers.api.error(`Calendar cache Redis get error for ${key}:`, error);
      }
    }

    loggers.api.debug(`Calendar cache miss: ${key}`);
    return null;
  }

  /**
   * Set cached calendar events
   */
  async setCachedEvents(
    pageId: string,
    data: AggregatedCalendarResult,
    startDate?: string,
    endDate?: string,
    ttl?: number
  ): Promise<void> {
    const key = this.getCacheKey(pageId, startDate, endDate);
    const cacheTTL = ttl || this.config.defaultTTL;

    const cacheEntry: CachedCalendarData = {
      pageId,
      startDate,
      endDate,
      data,
      cachedAt: Date.now(),
      ttl: cacheTTL,
    };

    // Set in L1 cache (memory)
    this.memoryCache.set(key, cacheEntry);

    // Set in L2 cache (Redis)
    if (this.isRedisAvailable && this.redis) {
      try {
        await this.redis.setex(
          key,
          cacheTTL,
          JSON.stringify(cacheEntry)
        );
        loggers.api.debug(`Calendar cache set: ${key}`);
      } catch (error) {
        loggers.api.error(`Calendar cache Redis set error for ${key}:`, error);
      }
    }
  }

  /**
   * Get cached personal calendar events
   */
  async getCachedPersonalEvents(
    userId: string,
    startDate?: string,
    endDate?: string
  ): Promise<AggregatedCalendarResult | null> {
    const key = this.getPersonalCacheKey(userId, startDate, endDate);

    // Try L1 cache (memory)
    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry) {
      const age = (Date.now() - memoryEntry.cachedAt) / 1000;
      if (age <= memoryEntry.ttl) {
        loggers.api.debug(`Personal calendar cache hit (L1): ${key}`);
        return memoryEntry.data;
      } else {
        this.memoryCache.delete(key);
      }
    }

    // Try L2 cache (Redis)
    if (this.isRedisAvailable && this.redis) {
      try {
        const cached = await this.redis.get(key);
        if (cached) {
          const parsed: CachedCalendarData = JSON.parse(cached);
          const age = (Date.now() - parsed.cachedAt) / 1000;

          if (age <= parsed.ttl) {
            this.memoryCache.set(key, parsed);
            loggers.api.debug(`Personal calendar cache hit (L2): ${key}`);
            return parsed.data;
          } else {
            await this.redis.del(key);
          }
        }
      } catch (error) {
        loggers.api.error(`Personal calendar cache Redis get error for ${key}:`, error);
      }
    }

    return null;
  }

  /**
   * Set cached personal calendar events
   */
  async setCachedPersonalEvents(
    userId: string,
    data: AggregatedCalendarResult,
    startDate?: string,
    endDate?: string,
    ttl?: number
  ): Promise<void> {
    const key = this.getPersonalCacheKey(userId, startDate, endDate);
    const cacheTTL = ttl || this.config.defaultTTL;

    const cacheEntry: CachedCalendarData = {
      pageId: '', // Not applicable for personal calendars
      userId,
      startDate,
      endDate,
      data,
      cachedAt: Date.now(),
      ttl: cacheTTL,
    };

    // Set in L1 cache
    this.memoryCache.set(key, cacheEntry);

    // Set in L2 cache
    if (this.isRedisAvailable && this.redis) {
      try {
        await this.redis.setex(
          key,
          cacheTTL,
          JSON.stringify(cacheEntry)
        );
        loggers.api.debug(`Personal calendar cache set: ${key}`);
      } catch (error) {
        loggers.api.error(`Personal calendar cache Redis set error for ${key}:`, error);
      }
    }
  }

  /**
   * Invalidate all cached events for a specific calendar page
   */
  async invalidateCalendar(pageId: string): Promise<void> {
    const pattern = `${this.config.keyPrefix}${pageId}*`;

    // Clear from memory cache
    for (const key of this.memoryCache.keys()) {
      if (key.startsWith(`${this.config.keyPrefix}${pageId}`)) {
        this.memoryCache.delete(key);
      }
    }

    // Clear from Redis
    if (this.isRedisAvailable && this.redis) {
      try {
        const keys = await this.redis.keys(pattern);
        if (keys.length > 0) {
          await this.redis.del(...keys);
          loggers.api.info(`Invalidated ${keys.length} calendar cache entries for page ${pageId}`);
        }
      } catch (error) {
        loggers.api.error(`Error invalidating calendar cache for ${pageId}:`, error);
      }
    }
  }

  /**
   * Invalidate all cached personal calendar events for a user
   */
  async invalidateUserPersonalCalendar(userId: string): Promise<void> {
    const pattern = `${this.config.keyPrefix}personal:${userId}*`;

    // Clear from memory cache
    for (const key of this.memoryCache.keys()) {
      if (key.startsWith(`${this.config.keyPrefix}personal:${userId}`)) {
        this.memoryCache.delete(key);
      }
    }

    // Clear from Redis
    if (this.isRedisAvailable && this.redis) {
      try {
        const keys = await this.redis.keys(pattern);
        if (keys.length > 0) {
          await this.redis.del(...keys);
          loggers.api.info(`Invalidated ${keys.length} personal calendar cache entries for user ${userId}`);
        }
      } catch (error) {
        loggers.api.error(`Error invalidating personal calendar cache for ${userId}:`, error);
      }
    }
  }

  /**
   * Clear all calendar cache entries
   */
  async clearAll(): Promise<void> {
    // Clear memory cache
    this.memoryCache.clear();

    // Clear Redis cache
    if (this.isRedisAvailable && this.redis) {
      try {
        const keys = await this.redis.keys(`${this.config.keyPrefix}*`);
        if (keys.length > 0) {
          await this.redis.del(...keys);
          loggers.api.info(`Cleared ${keys.length} calendar cache entries from Redis`);
        }
      } catch (error) {
        loggers.api.error('Error clearing calendar cache:', error);
      }
    }
  }

  /**
   * Cleanup on shutdown
   */
  async destroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }

    this.memoryCache.clear();
    CalendarCache.instance = null;
  }
}

// Export singleton instance
export const calendarCache = CalendarCache.getInstance();
