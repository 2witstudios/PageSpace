import type Redis from 'ioredis';
import { loggers } from '../logging/logger-config';
import { getTodayUTC, getSecondsUntilMidnightUTC } from './date-utils';
import { getSharedRedisClient, isSharedRedisAvailable } from './shared-redis';

// Types for rate limiting
export type ProviderType = 'standard' | 'pro';

export interface UsageTrackingResult {
  success: boolean;
  currentCount: number;
  limit: number;
  remainingCalls: number;
}

// Cache configuration
interface RateLimitConfig {
  enableRedis: boolean;
  keyPrefix: string;
}

/**
 * High-performance rate limiting service with hybrid in-memory + Redis architecture
 *
 * Features:
 * - Two-tier caching: in-memory (L1) + Redis (L2)
 * - Automatic 24-hour TTL expiry (resets at midnight UTC)
 * - Atomic increment operations with limit checking
 * - Graceful degradation when Redis is unavailable
 * - Production-ready error handling and monitoring
 */
export class RateLimitCache {
  private static instance: RateLimitCache | null = null;

  private redis: Redis | null = null;
  private memoryCache = new Map<string, { count: number; expiresAt: number }>();
  private config: RateLimitConfig;
  private initializationPromise: Promise<void> | null = null;

  private constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = {
      enableRedis: true,
      keyPrefix: 'pagespace:ratelimit:',
      ...config
    };

    this.initializationPromise = this.initializeRedis();
    this.startMemoryCacheCleanup();
  }

  /**
   * Get singleton instance
   */
  static getInstance(config?: Partial<RateLimitConfig>): RateLimitCache {
    if (!RateLimitCache.instance) {
      RateLimitCache.instance = new RateLimitCache(config);
    }
    return RateLimitCache.instance;
  }

  /**
   * Check if Redis is available (uses shared state)
   */
  private get isRedisAvailable(): boolean {
    return isSharedRedisAvailable() && this.redis !== null;
  }

  /**
   * Initialize Redis connection using shared client
   */
  private async initializeRedis(): Promise<void> {
    if (!this.config.enableRedis) return;

    try {
      this.redis = await getSharedRedisClient();
    } catch (error) {
      loggers.api.warn('Failed to get shared Redis client for rate limiting', {
        error: error instanceof Error ? error.message : String(error)
      });
      this.redis = null;
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
        if (now > entry.expiresAt) {
          this.memoryCache.delete(key);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        loggers.api.debug(`Cleaned ${cleanedCount} expired rate limit cache entries`);
      }
    }, 60000); // Clean every 60 seconds
  }

  /**
   * Generate cache key for rate limiting
   */
  private getRateLimitKey(userId: string, providerType: ProviderType): string {
    const date = getTodayUTC();
    return `${this.config.keyPrefix}${userId}:${date}:${providerType}`;
  }

  /**
   * Get TTL in seconds until midnight UTC (when limit resets)
   */
  private getTTL(): number {
    return getSecondsUntilMidnightUTC();
  }

  /**
   * Atomically increment usage count with limit check (Redis)
   */
  private async incrementRedis(
    key: string,
    limit: number
  ): Promise<UsageTrackingResult | null> {
    if (!this.isRedisAvailable || !this.redis) {
      return null;
    }

    try {
      // Use Redis INCR for atomic increment
      const newCount = await this.redis.incr(key);

      // Set TTL on first increment (when count was 1)
      if (newCount === 1) {
        const ttl = this.getTTL();
        await this.redis.expire(key, ttl);
      }

      // Check if limit exceeded
      if (newCount > limit) {
        // Decrement back (we exceeded the limit)
        await this.redis.decr(key);

        return {
          success: false,
          currentCount: limit,
          limit,
          remainingCalls: 0
        };
      }

      return {
        success: true,
        currentCount: newCount,
        limit,
        remainingCalls: limit - newCount
      };

    } catch (error) {
      loggers.api.warn('Redis increment error for rate limiting', { key, error });
      return null;
    }
  }

  /**
   * Atomically increment usage count with limit check (Memory fallback)
   */
  private incrementMemory(
    key: string,
    limit: number
  ): UsageTrackingResult {
    const now = Date.now();
    const ttl = this.getTTL() * 1000; // Convert to milliseconds
    const expiresAt = now + ttl;

    const existing = this.memoryCache.get(key);

    // Check if expired
    if (existing && now > existing.expiresAt) {
      this.memoryCache.delete(key);
    }

    const current = (existing && now <= existing.expiresAt) ? existing.count : 0;

    // Check limit
    if (current >= limit) {
      return {
        success: false,
        currentCount: current,
        limit,
        remainingCalls: 0
      };
    }

    // Increment
    const newCount = current + 1;
    this.memoryCache.set(key, { count: newCount, expiresAt });

    return {
      success: true,
      currentCount: newCount,
      limit,
      remainingCalls: limit - newCount
    };
  }

  /**
   * Increment usage count with limit check
   */
  async incrementUsage(
    userId: string,
    providerType: ProviderType,
    limit: number
  ): Promise<UsageTrackingResult> {
    const key = this.getRateLimitKey(userId, providerType);

    // Try Redis first (L2)
    const redisResult = await this.incrementRedis(key, limit);
    if (redisResult !== null) {
      // Update memory cache for fast reads
      const ttl = this.getTTL() * 1000;
      this.memoryCache.set(key, {
        count: redisResult.currentCount,
        expiresAt: Date.now() + ttl
      });
      return redisResult;
    }

    // Fallback to memory (L1)
    return this.incrementMemory(key, limit);
  }

  /**
   * Get current usage count without incrementing
   */
  async getCurrentUsage(
    userId: string,
    providerType: ProviderType,
    limit: number
  ): Promise<UsageTrackingResult> {
    const key = this.getRateLimitKey(userId, providerType);

    // Try memory cache first (L1)
    const now = Date.now();
    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry && now <= memoryEntry.expiresAt) {
      return {
        success: memoryEntry.count < limit,
        currentCount: memoryEntry.count,
        limit,
        remainingCalls: Math.max(0, limit - memoryEntry.count)
      };
    }

    // Try Redis (L2)
    if (this.isRedisAvailable && this.redis) {
      try {
        const countStr = await this.redis.get(key);
        const count = countStr ? parseInt(countStr, 10) : 0;

        // Promote to memory cache
        if (count > 0) {
          const ttl = this.getTTL() * 1000;
          this.memoryCache.set(key, {
            count,
            expiresAt: now + ttl
          });
        }

        return {
          success: count < limit,
          currentCount: count,
          limit,
          remainingCalls: Math.max(0, limit - count)
        };
      } catch (error) {
        loggers.api.warn('Redis get error for rate limiting', { key, error });
      }
    }

    // No data found, return zero usage
    return {
      success: true,
      currentCount: 0,
      limit,
      remainingCalls: limit
    };
  }

  /**
   * Reset usage for a user (for testing or admin purposes)
   */
  async resetUsage(userId: string, providerType: ProviderType): Promise<void> {
    const key = this.getRateLimitKey(userId, providerType);

    // Clear from memory
    this.memoryCache.delete(key);

    // Clear from Redis
    if (this.isRedisAvailable && this.redis) {
      try {
        await this.redis.del(key);
      } catch (error) {
        loggers.api.warn('Redis delete error for rate limiting', { key, error });
      }
    }

    loggers.api.debug(`Reset rate limit for user`, { userId, providerType });
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    memoryEntries: number;
    redisAvailable: boolean;
  } {
    return {
      memoryEntries: this.memoryCache.size,
      redisAvailable: this.isRedisAvailable
    };
  }

  /**
   * Wait for initialization to complete (useful for tests)
   */
  async waitForReady(): Promise<void> {
    if (this.initializationPromise) {
      await this.initializationPromise;
    }
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
        loggers.api.warn('Redis clear all error for rate limiting', { error });
      }
    }

    loggers.api.info('Cleared all rate limit cache entries');
  }

  /**
   * Graceful shutdown
   * Note: Does not close the shared Redis connection - that's managed by shared-redis.ts
   */
  async shutdown(): Promise<void> {
    this.redis = null;
    this.memoryCache.clear();
    RateLimitCache.instance = null;
  }
}

// Export singleton instance
export const rateLimitCache = RateLimitCache.getInstance();
