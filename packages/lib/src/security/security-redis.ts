/**
 * Security-Specific Redis Utilities
 *
 * Provides Redis operations for security features:
 * - JTI (JWT ID) tracking and revocation
 * - Distributed rate limiting
 * - Session management
 *
 * Uses key prefixes to namespace security data:
 * - `sec:jti:` - JWT ID tracking
 * - `sec:rate:` - Rate limiting
 * - `sec:session:` - Session data
 */

import Redis from 'ioredis';
import { getSharedRedisClient, isSharedRedisAvailable } from '../services/shared-redis';
import { loggers } from '../logging/logger-config';

const KEY_PREFIX = 'sec:';

// Separate clients for sessions and rate limiting
let sessionRedisClient: Redis | null = null;
let rateLimitRedisClient: Redis | null = null;

/**
 * Get the session Redis client (Database 0 for JTI tracking and session data).
 * Falls back to REDIS_URL if REDIS_SESSION_URL not configured.
 */
async function getSessionRedisClient(): Promise<Redis> {
  if (sessionRedisClient) return sessionRedisClient;

  const sessionUrl = process.env.REDIS_SESSION_URL || process.env.REDIS_URL;
  if (!sessionUrl) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('REDIS_SESSION_URL required in production');
    }
    throw new Error('Redis not available');
  }

  sessionRedisClient = new Redis(sessionUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });

  await sessionRedisClient.ping();
  return sessionRedisClient;
}

/**
 * Try to get session Redis client without throwing in non-production.
 * Re-throws in production to preserve strict security behavior.
 */
async function tryGetSessionRedisClient(): Promise<Redis | null> {
  try {
    return await getSessionRedisClient();
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      throw error;
    }
    return null;
  }
}

/**
 * Get the rate limiting Redis client (Database 1 for distributed rate limit counters).
 * Falls back to REDIS_URL if REDIS_RATE_LIMIT_URL not configured.
 */
async function getRateLimitRedisClient(): Promise<Redis> {
  if (rateLimitRedisClient) return rateLimitRedisClient;

  const rateLimitUrl = process.env.REDIS_RATE_LIMIT_URL || process.env.REDIS_URL;
  if (!rateLimitUrl) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('REDIS_RATE_LIMIT_URL required in production');
    }
    throw new Error('Redis not available');
  }

  rateLimitRedisClient = new Redis(rateLimitUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });

  await rateLimitRedisClient.ping();
  return rateLimitRedisClient;
}

/**
 * Get the security Redis client.
 * In production, this MUST be available - throws if not.
 * @deprecated Use getSessionRedisClient() or getRateLimitRedisClient() instead
 */
export async function getSecurityRedisClient(): Promise<Redis> {
  const client = await getSharedRedisClient();

  if (!client) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Redis required for security features in production');
    }
    throw new Error('Redis not available');
  }

  return client;
}

/**
 * Check if security Redis is available.
 * Returns false if Redis is not configured or connection failed.
 */
export function isSecurityRedisAvailable(): boolean {
  return isSharedRedisAvailable();
}

/**
 * Try to get security Redis client without throwing.
 * Returns null if unavailable (useful for graceful degradation in development).
 */
export async function tryGetSecurityRedisClient(): Promise<Redis | null> {
  try {
    return await getSecurityRedisClient();
  } catch {
    return null;
  }
}

// =============================================================================
// JTI (JWT ID) Operations
// =============================================================================

/**
 * Record a new JTI (JWT ID) for a service token.
 * The JTI is stored with a TTL matching the token's expiration.
 */
export async function recordJTI(
  jti: string,
  userId: string,
  expiresInSeconds: number
): Promise<void> {
  const redis = await tryGetSessionRedisClient();
  if (!redis) return;
  const key = `${KEY_PREFIX}jti:${jti}`;

  // Store as valid with user ID for potential auditing
  await redis.setex(key, expiresInSeconds, JSON.stringify({
    status: 'valid',
    userId,
    createdAt: Date.now(),
  }));
}

/**
 * Check if a JTI is revoked.
 * Returns true if:
 * - JTI is explicitly revoked
 * - JTI is not found (expired or never recorded)
 */
export async function isJTIRevoked(jti: string): Promise<boolean> {
  const redis = await tryGetSessionRedisClient();
  if (!redis) return false;
  const key = `${KEY_PREFIX}jti:${jti}`;

  const value = await redis.get(key);

  if (!value) {
    // Not found = treat as revoked (fail closed)
    return true;
  }

  try {
    const data = JSON.parse(value);
    return data.status === 'revoked';
  } catch {
    // Corrupted data = treat as revoked
    return true;
  }
}

/**
 * Revoke a specific JTI.
 * The revocation is stored with the remaining TTL.
 */
export async function revokeJTI(jti: string, reason: string): Promise<boolean> {
  const redis = await tryGetSessionRedisClient();
  if (!redis) return false;
  const key = `${KEY_PREFIX}jti:${jti}`;

  // Get remaining TTL
  const ttl = await redis.ttl(key);

  if (ttl <= 0) {
    // Already expired or doesn't exist
    return false;
  }

  // Get existing data for audit trail
  const existing = await redis.get(key);
  let userId: string | undefined;

  try {
    if (existing) {
      const data = JSON.parse(existing);
      userId = data.userId;
    }
  } catch {
    // Ignore parse errors
  }

  // Mark as revoked with remaining TTL
  await redis.setex(key, ttl, JSON.stringify({
    status: 'revoked',
    userId,
    revokedAt: Date.now(),
    reason,
  }));

  loggers.api.info('JTI revoked', { jti: '[REDACTED]', reason });
  return true;
}

/**
 * Revoke all JTIs for a user by bumping their token version.
 * This is handled at the database level, not Redis.
 * This function exists for API consistency but doesn't modify Redis directly.
 */
export async function revokeAllUserJTIs(userId: string): Promise<void> {
  // JTI revocation for all user tokens is handled by bumping tokenVersion
  // in the users table. This causes all existing JTIs to fail validation
  // when the tokenVersion is checked.
  //
  // We don't scan Redis for all JTIs because:
  // 1. It's expensive (SCAN is O(n))
  // 2. JTIs are short-lived (5 min) so they'll expire anyway
  // 3. tokenVersion check is the authoritative source
  loggers.api.info('User token version will be bumped for JTI revocation', { userId });
}

// =============================================================================
// Rate Limiting Operations
// =============================================================================

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  totalCount: number;
}

/**
 * Check rate limit using sliding window algorithm.
 * Uses Redis sorted set for accurate sliding window.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const redis = await getRateLimitRedisClient();
  const redisKey = `${KEY_PREFIX}rate:${key}`;
  const now = Date.now();
  const windowStart = now - windowMs;

  // Atomic operations using pipeline
  const pipeline = redis.pipeline();

  // Remove old entries outside the window
  pipeline.zremrangebyscore(redisKey, 0, windowStart);

  // Add current request with timestamp as score
  pipeline.zadd(redisKey, now, `${now}-${Math.random().toString(36).slice(2)}`);

  // Count entries in window
  pipeline.zcard(redisKey);

  // Set expiry to clean up the key
  pipeline.pexpire(redisKey, windowMs);

  const results = await pipeline.exec();

  // Get the count from zcard result
  const totalCount = (results?.[2]?.[1] as number) ?? 0;

  return {
    allowed: totalCount <= limit,
    remaining: Math.max(0, limit - totalCount),
    resetAt: new Date(now + windowMs),
    totalCount,
  };
}

/**
 * Get current rate limit status without incrementing.
 */
export async function getRateLimitStatus(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const redis = await getRateLimitRedisClient();
  const redisKey = `${KEY_PREFIX}rate:${key}`;
  const now = Date.now();
  const windowStart = now - windowMs;

  // Count entries in window without modifying
  const count = await redis.zcount(redisKey, windowStart, now);

  return {
    allowed: count < limit,
    remaining: Math.max(0, limit - count),
    resetAt: new Date(now + windowMs),
    totalCount: count,
  };
}

/**
 * Reset rate limit for a key (e.g., after successful login).
 */
export async function resetRateLimit(key: string): Promise<void> {
  const redis = await getRateLimitRedisClient();
  const redisKey = `${KEY_PREFIX}rate:${key}`;
  await redis.del(redisKey);
}

// =============================================================================
// Session Operations (for future use)
// =============================================================================

/**
 * Store session data with expiry.
 */
export async function setSessionData(
  sessionId: string,
  data: Record<string, unknown>,
  expiresInSeconds: number
): Promise<void> {
  const redis = await getSessionRedisClient();
  const key = `${KEY_PREFIX}session:${sessionId}`;
  await redis.setex(key, expiresInSeconds, JSON.stringify(data));
}

/**
 * Get session data.
 */
export async function getSessionData(
  sessionId: string
): Promise<Record<string, unknown> | null> {
  const redis = await getSessionRedisClient();
  const key = `${KEY_PREFIX}session:${sessionId}`;
  const value = await redis.get(key);

  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Delete session data.
 */
export async function deleteSessionData(sessionId: string): Promise<void> {
  const redis = await getSessionRedisClient();
  const key = `${KEY_PREFIX}session:${sessionId}`;
  await redis.del(key);
}

// =============================================================================
// Health Check
// =============================================================================

/**
 * Check security Redis health.
 * Returns detailed status for monitoring.
 */
export async function checkSecurityRedisHealth(): Promise<{
  available: boolean;
  latencyMs?: number;
  error?: string;
}> {
  const start = Date.now();

  try {
    const redis = await getSecurityRedisClient();
    await redis.ping();

    return {
      available: true,
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      available: false,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
