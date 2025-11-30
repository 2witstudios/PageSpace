import Redis from 'ioredis';
import { loggers } from '../logging/logger-config';

/**
 * Cached agent data for the agent awareness system
 */
export interface CachedAgent {
  id: string;
  title: string;
  definition: string | null;
}

/**
 * Cached agents for a drive
 */
export interface CachedDriveAgents {
  driveId: string;
  driveName: string;
  agents: CachedAgent[];
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
 * Agent Awareness Cache Service
 *
 * Caches visible AI agents per drive to reduce database queries when building
 * the global assistant's system prompt. Uses the same two-tier architecture
 * as PermissionCache (L1 memory + L2 Redis).
 *
 * Cache key: `pagespace:agents:drive:${driveId}` → array of visible agents
 *
 * Invalidation triggers:
 * - AI_CHAT page created
 * - AI_CHAT page deleted/trashed
 * - Agent visibility toggle changed
 * - Agent definition edited
 * - Agent title changed
 */
export class AgentAwarenessCache {
  private static instance: AgentAwarenessCache | null = null;

  private redis: Redis | null = null;
  private memoryCache = new Map<string, CachedDriveAgents>();
  private config: CacheConfig;
  private isRedisAvailable = false;

  private constructor(config: Partial<CacheConfig> = {}) {
    this.config = {
      defaultTTL: 300, // 5 minutes - agents change less frequently than permissions
      maxMemoryEntries: 500, // Limit memory cache size
      enableRedis: true,
      keyPrefix: 'pagespace:agents:',
      ...config
    };

    this.initializeRedis();
    this.startMemoryCacheCleanup();
  }

  /**
   * Get singleton instance
   */
  static getInstance(config?: Partial<CacheConfig>): AgentAwarenessCache {
    if (!AgentAwarenessCache.instance) {
      AgentAwarenessCache.instance = new AgentAwarenessCache(config);
    }
    return AgentAwarenessCache.instance;
  }

  /**
   * Initialize Redis connection with graceful fallback
   */
  private async initializeRedis(): Promise<void> {
    if (!this.config.enableRedis) return;

    try {
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) {
        loggers.api.debug('REDIS_URL not configured, using memory-only agent cache');
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
        loggers.api.debug('Redis connected for agent awareness caching');
      });

      this.redis.on('error', (error: Error) => {
        this.isRedisAvailable = false;
        loggers.api.warn('Redis connection error for agent cache, falling back to memory', error);
      });

      this.redis.on('close', () => {
        this.isRedisAvailable = false;
      });

      // Test connection
      await this.redis.ping();
      this.isRedisAvailable = true;

    } catch (error) {
      loggers.api.debug('Failed to initialize Redis for agent cache, using memory-only', {
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

      // Enforce size limit
      if (this.memoryCache.size > this.config.maxMemoryEntries) {
        const excess = this.memoryCache.size - this.config.maxMemoryEntries;
        const keysToDelete = Array.from(this.memoryCache.keys()).slice(0, excess);
        keysToDelete.forEach(key => this.memoryCache.delete(key));
        cleanedCount += keysToDelete.length;
      }

      if (cleanedCount > 0) {
        loggers.api.debug(`Cleaned ${cleanedCount} expired agent cache entries`);
      }
    }, 60000); // Clean every minute
  }

  /**
   * Generate cache key for drive agents
   */
  private getDriveAgentsKey(driveId: string): string {
    return `${this.config.keyPrefix}drive:${driveId}`;
  }

  /**
   * Get agents for a drive from cache (L1 memory -> L2 Redis)
   */
  async getDriveAgents(driveId: string): Promise<CachedDriveAgents | null> {
    const key = this.getDriveAgentsKey(driveId);

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
          const parsed = JSON.parse(redisResult) as CachedDriveAgents;

          // Promote to L1 cache
          this.memoryCache.set(key, parsed);
          return parsed;
        }
      } catch (error) {
        loggers.api.warn('Redis get error for agent cache', { key, error });
      }
    }

    return null;
  }

  /**
   * Set agents for a drive in cache (L1 + L2)
   */
  async setDriveAgents(
    driveId: string,
    driveName: string,
    agents: CachedAgent[],
    ttl: number = this.config.defaultTTL
  ): Promise<void> {
    const key = this.getDriveAgentsKey(driveId);
    const cached: CachedDriveAgents = {
      driveId,
      driveName,
      agents,
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
        loggers.api.warn('Redis set error for agent cache', { key, error });
      }
    }
  }

  /**
   * Invalidate cache for a specific drive
   * Call this when an agent in the drive is created, updated, or deleted
   */
  async invalidateDriveAgents(driveId: string): Promise<void> {
    const key = this.getDriveAgentsKey(driveId);

    // Clear from memory cache
    this.memoryCache.delete(key);

    // Clear from Redis cache
    if (this.isRedisAvailable && this.redis) {
      try {
        await this.redis.del(key);
      } catch (error) {
        loggers.api.warn('Redis delete error for agent cache', { key, error });
      }
    }

    loggers.api.debug(`Invalidated agent cache for drive ${driveId}`);
  }

  /**
   * Invalidate all agent cache entries
   * Use sparingly - only for edge cases like bulk operations
   */
  async invalidateAllAgents(): Promise<void> {
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
        loggers.api.warn('Redis clear all error for agent cache', { error });
      }
    }

    loggers.api.debug('Invalidated all agent cache entries');
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
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
    this.memoryCache.clear();
    AgentAwarenessCache.instance = null;
  }
}

// Lazy initialization helper
let cacheInstance: AgentAwarenessCache | null = null;

export function getAgentAwarenessCache(): AgentAwarenessCache {
  if (!cacheInstance) {
    cacheInstance = AgentAwarenessCache.getInstance();
  }
  return cacheInstance;
}

// Export for direct import
export const agentAwarenessCache = {
  getDriveAgents: (driveId: string) => getAgentAwarenessCache().getDriveAgents(driveId),
  setDriveAgents: (driveId: string, driveName: string, agents: CachedAgent[], ttl?: number) =>
    getAgentAwarenessCache().setDriveAgents(driveId, driveName, agents, ttl),
  invalidateDriveAgents: (driveId: string) => getAgentAwarenessCache().invalidateDriveAgents(driveId),
  invalidateAllAgents: () => getAgentAwarenessCache().invalidateAllAgents(),
  getCacheStats: () => getAgentAwarenessCache().getCacheStats(),
};
