import Redis from 'ioredis';
import { loggers } from '../logging/logger-config';

/**
 * Shared Redis Client Utility
 *
 * Provides a single Redis connection shared across all cache services
 * (PermissionCache, AgentAwarenessCache, etc.) to avoid duplicate connections.
 *
 * Features:
 * - Singleton Redis connection
 * - Graceful fallback when Redis unavailable
 * - Connection promise deduplication (prevents race conditions)
 * - Event-based status tracking
 */

let sharedRedisClient: Redis | null = null;
let connectionPromise: Promise<Redis | null> | null = null;
let redisAvailable = false;

/**
 * Get the shared Redis client instance.
 * Returns null if Redis is not configured or connection fails.
 */
export async function getSharedRedisClient(): Promise<Redis | null> {
  // Return existing client if available
  if (sharedRedisClient && redisAvailable) {
    return sharedRedisClient;
  }

  // Return pending connection promise to avoid duplicate connections
  if (connectionPromise) {
    return connectionPromise;
  }

  // Initialize new connection
  connectionPromise = initializeRedis();
  return connectionPromise;
}

/**
 * Check if Redis is currently available
 */
export function isSharedRedisAvailable(): boolean {
  return redisAvailable;
}

/**
 * Initialize Redis connection with graceful error handling
 */
async function initializeRedis(): Promise<Redis | null> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    loggers.api.debug('REDIS_URL not configured, caches will use memory-only mode');
    return null;
  }

  try {
    const redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      connectTimeout: 5000,
      commandTimeout: 3000,
    });

    // Set up event handlers
    redis.on('connect', () => {
      redisAvailable = true;
      loggers.api.info('Shared Redis client connected');
    });

    redis.on('error', (error: Error) => {
      redisAvailable = false;
      loggers.api.warn('Shared Redis connection error, caches falling back to memory', error);
    });

    redis.on('close', () => {
      redisAvailable = false;
      loggers.api.debug('Shared Redis connection closed');
    });

    redis.on('reconnecting', () => {
      loggers.api.debug('Shared Redis reconnecting...');
    });

    // Explicitly connect first (uses connectTimeout), then ping (uses commandTimeout)
    // This fixes a timing bug where lazyConnect + commandTimeout race:
    // https://github.com/redis/ioredis/issues/1431
    await redis.connect();
    await redis.ping();
    sharedRedisClient = redis;
    redisAvailable = true;

    return redis;
  } catch (error) {
    loggers.api.warn('Failed to initialize shared Redis client, using memory-only caches', {
      error: error instanceof Error ? error.message : String(error)
    });
    connectionPromise = null;
    return null;
  }
}
