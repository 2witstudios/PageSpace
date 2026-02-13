import type Redis from 'ioredis';
import { loggers } from '../logging/logger-config';
import { getSharedRedisClient, isSharedRedisAvailable } from './shared-redis';

// Types for cached conversation data
export interface CachedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;              // Structured JSON or plain text
  toolCalls: string | null;     // JSON string
  toolResults: string | null;   // JSON string
  createdAt: number;            // Unix timestamp
  editedAt: number | null;
  messageType: 'standard' | 'todo_list';
}

export interface CachedConversation {
  pageId: string;
  conversationId: string;
  messages: CachedMessage[];
  cachedAt: number;
  ttl: number;
}

export interface ConversationCacheMetrics {
  hits: number;
  misses: number;
  invalidations: number;
  invalidationFailures: number;
  ttlExpirations: number;
  redisErrors: number;
  appendOperations: number;
}

// Cache configuration
interface CacheConfig {
  defaultTTL: number;           // seconds
  maxMemoryEntries: number;     // max conversations in L1
  maxMessagesPerConversation: number;
  enableRedis: boolean;
  keyPrefix: string;
}

/**
 * High-performance conversation caching service with hybrid in-memory + Redis architecture
 *
 * Features:
 * - Two-tier caching: in-memory (L1) + Redis (L2)
 * - Optimistic append for new messages
 * - Automatic TTL and cache invalidation
 * - Graceful degradation when Redis is unavailable
 * - Production-ready error handling and monitoring
 */
export class ConversationCache {
  private static instance: ConversationCache | null = null;

  private redis: Redis | null = null;
  private memoryCache = new Map<string, CachedConversation>();
  private config: CacheConfig;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private metrics: ConversationCacheMetrics = {
    hits: 0,
    misses: 0,
    invalidations: 0,
    invalidationFailures: 0,
    ttlExpirations: 0,
    redisErrors: 0,
    appendOperations: 0,
  };

  private constructor(config: Partial<CacheConfig> = {}) {
    this.config = {
      defaultTTL: 1800,                    // 30 minutes
      maxMemoryEntries: 300,               // Limit memory cache size
      maxMessagesPerConversation: 500,     // Truncate older messages
      enableRedis: true,
      keyPrefix: 'pagespace:chat:',
      ...config
    };

    this.initializeRedis();
    this.startMemoryCacheCleanup();
  }

  /**
   * Get singleton instance
   */
  static getInstance(config?: Partial<CacheConfig>): ConversationCache {
    if (!ConversationCache.instance) {
      ConversationCache.instance = new ConversationCache(config);
    }
    return ConversationCache.instance;
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
      loggers.api.warn('Failed to get shared Redis client for conversation cache', {
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
   * Generate cache key for a conversation
   */
  private getConversationKey(pageId: string, conversationId: string): string {
    return `${this.config.keyPrefix}${pageId}:${conversationId}`;
  }

  /**
   * Generate pattern for all conversations in a page
   */
  private getPagePattern(pageId: string): string {
    return `${this.config.keyPrefix}${pageId}:*`;
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

      // Enforce size limit - remove oldest entries first
      if (this.memoryCache.size > this.config.maxMemoryEntries) {
        const excess = this.memoryCache.size - this.config.maxMemoryEntries;
        const sortedEntries = Array.from(this.memoryCache.entries())
          .sort((a, b) => a[1].cachedAt - b[1].cachedAt);

        for (let i = 0; i < excess && i < sortedEntries.length; i++) {
          this.memoryCache.delete(sortedEntries[i][0]);
          cleanedCount++;
        }
      }

      this.metrics.ttlExpirations += cleanedCount;

      const totalRequests = this.metrics.hits + this.metrics.misses;
      const hitRate = totalRequests > 0 ? Math.round((this.metrics.hits / totalRequests) * 100) : 0;
      loggers.performance.debug('Conversation cache stats', {
        memoryEntries: this.memoryCache.size,
        hitRate: `${hitRate}%`,
        ...this.metrics,
      });
    }, 60000); // Clean every 60 seconds
  }

  /**
   * Get conversation from cache (L1 memory -> L2 Redis -> null)
   */
  async getConversation(pageId: string, conversationId: string): Promise<CachedConversation | null> {
    const key = this.getConversationKey(pageId, conversationId);

    // L1: Check memory cache first
    const memoryResult = this.memoryCache.get(key);
    if (memoryResult) {
      if (Date.now() < memoryResult.cachedAt + (memoryResult.ttl * 1000)) {
        this.metrics.hits++;
        loggers.ai.debug('Conversation cache hit (L1)', { pageId, conversationId });
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
          const parsed = JSON.parse(redisResult) as CachedConversation;

          // Promote to L1 cache
          this.memoryCache.set(key, parsed);
          this.metrics.hits++;
          loggers.ai.debug('Conversation cache hit (L2)', { pageId, conversationId });
          return parsed;
        }
      } catch (error) {
        this.metrics.redisErrors++;
        loggers.api.warn('Redis get error for conversation', { key, error });
      }
    }

    this.metrics.misses++;
    loggers.ai.debug('Conversation cache miss', { pageId, conversationId });
    return null;
  }

  /**
   * Set conversation in cache (L1 + L2)
   * Called after loading from database
   */
  async setConversation(
    pageId: string,
    conversationId: string,
    messages: CachedMessage[],
    ttl: number = this.config.defaultTTL
  ): Promise<void> {
    const key = this.getConversationKey(pageId, conversationId);

    // Truncate messages if exceeding limit (keep most recent)
    const truncatedMessages = messages.length > this.config.maxMessagesPerConversation
      ? messages.slice(-this.config.maxMessagesPerConversation)
      : messages;

    const cached: CachedConversation = {
      pageId,
      conversationId,
      messages: truncatedMessages,
      cachedAt: Date.now(),
      ttl
    };

    // Store in L1 (memory)
    this.memoryCache.set(key, cached);

    // Store in L2 (Redis) - fire-and-forget since L1 is already updated
    if (this.isRedisAvailable && this.redis) {
      this.redis.setex(key, ttl, JSON.stringify(cached)).catch((error) => {
        this.metrics.redisErrors++;
        loggers.api.warn('Redis set error for conversation', { key, error });
      });
    }

    loggers.ai.debug('Conversation cached', {
      pageId,
      conversationId,
      messageCount: truncatedMessages.length
    });
  }

  /**
   * Append a message to an existing cached conversation
   * Called after saving a new message to DB
   *
   * Note: Does nothing if conversation is not already cached
   * This is optimistic - if the cache entry exists, we append to avoid
   * invalidation overhead for the common case
   */
  async appendMessage(
    pageId: string,
    conversationId: string,
    message: CachedMessage
  ): Promise<void> {
    const key = this.getConversationKey(pageId, conversationId);

    // Check L1 first
    const memoryResult = this.memoryCache.get(key);
    if (memoryResult) {
      // Upsert: replace existing message with same ID, or append if new
      const existingIndex = memoryResult.messages.findIndex(m => m.id === message.id);
      if (existingIndex >= 0) {
        memoryResult.messages[existingIndex] = message;
      } else {
        memoryResult.messages.push(message);
      }
      memoryResult.cachedAt = Date.now(); // Refresh TTL

      // Truncate if exceeding limit
      if (memoryResult.messages.length > this.config.maxMessagesPerConversation) {
        memoryResult.messages = memoryResult.messages.slice(-this.config.maxMessagesPerConversation);
      }

      this.metrics.appendOperations++;

      // Update L2 (Redis) - fire-and-forget
      if (this.isRedisAvailable && this.redis) {
        this.redis.setex(key, memoryResult.ttl, JSON.stringify(memoryResult)).catch((error) => {
          this.metrics.redisErrors++;
          loggers.api.warn('Redis append error for conversation', { key, error });
        });
      }

      loggers.ai.debug('Message appended to cache', { pageId, conversationId });
      return;
    }

    // If not in L1 but might be in L2, check Redis
    if (this.isRedisAvailable && this.redis) {
      try {
        const redisResult = await this.redis.get(key);
        if (redisResult) {
          const parsed = JSON.parse(redisResult) as CachedConversation;
          // Upsert: replace existing message with same ID, or append if new
          const existingIndex = parsed.messages.findIndex(m => m.id === message.id);
          if (existingIndex >= 0) {
            parsed.messages[existingIndex] = message;
          } else {
            parsed.messages.push(message);
          }
          parsed.cachedAt = Date.now();

          // Truncate if exceeding limit
          if (parsed.messages.length > this.config.maxMessagesPerConversation) {
            parsed.messages = parsed.messages.slice(-this.config.maxMessagesPerConversation);
          }

          // Update both L1 and L2
          this.memoryCache.set(key, parsed);
          this.redis.setex(key, parsed.ttl, JSON.stringify(parsed)).catch((error) => {
            this.metrics.redisErrors++;
            loggers.api.warn('Redis update error after append', { key, error });
          });

          this.metrics.appendOperations++;
          loggers.ai.debug('Message appended to cache (from L2)', { pageId, conversationId });
        }
      } catch (error) {
        this.metrics.redisErrors++;
        loggers.api.warn('Redis get error during append', { key, error });
      }
    }

    // If not cached at all, do nothing - next read will populate from DB
  }

  /**
   * Invalidate a single conversation cache entry
   * Called after message edit or delete
   */
  async invalidateConversation(pageId: string, conversationId: string): Promise<void> {
    const key = this.getConversationKey(pageId, conversationId);

    // Clear from L1
    this.memoryCache.delete(key);

    // Clear from L2
    if (this.isRedisAvailable && this.redis) {
      try {
        await this.redis.del(key);
      } catch (error) {
        this.metrics.invalidationFailures++;
        this.metrics.redisErrors++;
        loggers.api.warn('Redis invalidation error', { key, error });
        return;
      }
    }

    this.metrics.invalidations++;
    loggers.ai.debug('Conversation cache invalidated', { pageId, conversationId });
  }

  /**
   * Invalidate all conversation caches for a page
   * Called when page is deleted or major changes occur
   */
  async invalidatePage(pageId: string): Promise<void> {
    // Clear from L1 - find all keys matching this page
    const keysToDelete: string[] = [];
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.pageId === pageId) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(key => this.memoryCache.delete(key));

    // Clear from L2
    if (this.isRedisAvailable && this.redis) {
      try {
        const pattern = this.getPagePattern(pageId);
        const keys = await this.redis.keys(pattern);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } catch (error) {
        this.metrics.invalidationFailures++;
        this.metrics.redisErrors++;
        loggers.api.warn('Redis page invalidation error', { pageId, error });
        return;
      }
    }

    this.metrics.invalidations++;
    loggers.ai.debug('Page cache invalidated', { pageId, entriesCleared: keysToDelete.length });
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    memoryEntries: number;
    redisAvailable: boolean;
    maxMemoryEntries: number;
    memoryUsagePercent: number;
    metrics: ConversationCacheMetrics;
  } {
    return {
      memoryEntries: this.memoryCache.size,
      redisAvailable: this.isRedisAvailable,
      maxMemoryEntries: this.config.maxMemoryEntries,
      memoryUsagePercent: Math.round((this.memoryCache.size / this.config.maxMemoryEntries) * 100),
      metrics: { ...this.metrics },
    };
  }

  /**
   * Reset metrics (useful for testing or monitoring windows)
   */
  resetMetrics(): void {
    this.metrics = {
      hits: 0,
      misses: 0,
      invalidations: 0,
      invalidationFailures: 0,
      ttlExpirations: 0,
      redisErrors: 0,
      appendOperations: 0,
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

    loggers.api.info('Cleared all conversation cache entries');
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
    ConversationCache.instance = null;
  }
}

// Export singleton instance
export const conversationCache = ConversationCache.getInstance();
