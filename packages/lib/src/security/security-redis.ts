/**
 * Security-Specific Redis + Postgres Utilities
 *
 * - JTI (JWT ID) tracking and revocation — Postgres (`revoked_service_tokens`)
 * - Distributed rate limiting — Redis (`sec:rate:` prefix)
 * - Session management — Redis (`sec:session:` prefix)
 */

import Redis from 'ioredis';
import { getSharedRedisClient, isSharedRedisAvailable } from '../services/shared-redis';
import { loggers } from '../logging/logger-config';
import { db, revokedServiceTokens, and, eq, gt, lt, sql } from '@pagespace/db';

const KEY_PREFIX = 'sec:';

// Separate clients for sessions and rate limiting
let sessionRedisClient: Redis | null = null;
let rateLimitRedisClient: Redis | null = null;

/**
 * Common Redis client options with reconnection support.
 */
const REDIS_CLIENT_OPTIONS = {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
  // Reconnection strategy: exponential backoff up to 3 seconds
  retryStrategy: (times: number) => {
    if (times > 10) {
      // After 10 retries, stop trying
      return null;
    }
    return Math.min(times * 100, 3000);
  },
  // Reconnect on certain errors
  reconnectOnError: (err: Error) => {
    const targetErrors = ['READONLY', 'ECONNRESET', 'ECONNREFUSED'];
    return targetErrors.some(e => err.message.includes(e));
  },
};

/**
 * Get the session Redis client (Database 0 for JTI tracking and session data).
 * Falls back to REDIS_URL if REDIS_SESSION_URL not configured.
 */
async function getSessionRedisClient(): Promise<Redis> {
  // Check if client is connected (status varies by ioredis version: 'ready' or 'connect')
  const sessionStatus = sessionRedisClient?.status as string;
  if (sessionStatus === 'ready' || sessionStatus === 'connect') {
    return sessionRedisClient!;
  }

  // Reset if connection is broken
  if (sessionRedisClient && sessionStatus !== 'ready' && sessionStatus !== 'connect') {
    try {
      await sessionRedisClient.quit();
    } catch {
      // Ignore quit errors
    }
    sessionRedisClient = null;
  }

  const sessionUrl = process.env.REDIS_SESSION_URL || process.env.REDIS_URL;
  if (!sessionUrl) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('REDIS_SESSION_URL required in production');
    }
    throw new Error('Redis not available');
  }

  sessionRedisClient = new Redis(sessionUrl, REDIS_CLIENT_OPTIONS);

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
  // Check if client is connected (status varies by ioredis version: 'ready' or 'connect')
  const rateLimitStatus = rateLimitRedisClient?.status as string;
  if (rateLimitStatus === 'ready' || rateLimitStatus === 'connect') {
    return rateLimitRedisClient!;
  }

  // Reset if connection is broken
  if (rateLimitRedisClient && rateLimitStatus !== 'ready' && rateLimitStatus !== 'connect') {
    try {
      await rateLimitRedisClient.quit();
    } catch {
      // Ignore quit errors
    }
    rateLimitRedisClient = null;
  }

  const rateLimitUrl = process.env.REDIS_RATE_LIMIT_URL || process.env.REDIS_URL;
  if (!rateLimitUrl) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('REDIS_RATE_LIMIT_URL required in production');
    }
    throw new Error('Redis not available');
  }

  rateLimitRedisClient = new Redis(rateLimitUrl, REDIS_CLIENT_OPTIONS);

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

/**
 * Try to get rate limit Redis client without throwing.
 * Re-throws in production to preserve strict security behavior.
 */
export async function tryGetRateLimitRedisClient(): Promise<Redis | null> {
  try {
    return await getRateLimitRedisClient();
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      throw error;
    }
    return null;
  }
}

// =============================================================================
// JTI (JWT ID) Operations
// =============================================================================

/**
 * Record a new JTI (JWT ID) for a service token.
 *
 * Inserts a row into `revoked_service_tokens` with `revoked_at = NULL` and
 * `expires_at = now + expiresInSeconds`. The row tracks that the JTI was
 * issued; `revokeJTI` later sets `revoked_at` to flip it to revoked.
 *
 * SECURITY: In production, throws if the DB write fails (fail-closed).
 * In development, logs a warning and continues (graceful degradation).
 */
export async function recordJTI(
  jti: string,
  userId: string,
  expiresInSeconds: number
): Promise<void> {
  try {
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    await db
      .insert(revokedServiceTokens)
      .values({ jti, revokedAt: null, expiresAt })
      .onConflictDoNothing({ target: revokedServiceTokens.jti });
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      throw error;
    }
    loggers.api.warn('JTI recording skipped: DB unavailable', { userId });
  }
}

/**
 * Check if a JTI is revoked.
 * Returns true (revoked) if:
 * - The row exists and `revoked_at IS NOT NULL`
 * - The row exists but is past its `expires_at`
 * - No row exists (token was never recorded — fail closed)
 *
 * SECURITY: Always fails closed — when in doubt, treat token as revoked.
 * In production, re-throws on DB failure rather than silently returning true,
 * so upstream retries / health checks can see the outage.
 */
export async function isJTIRevoked(jti: string): Promise<boolean> {
  try {
    const rows = await db
      .select({
        revokedAt: revokedServiceTokens.revokedAt,
        expiresAt: revokedServiceTokens.expiresAt,
      })
      .from(revokedServiceTokens)
      .where(eq(revokedServiceTokens.jti, jti))
      .limit(1);

    if (rows.length === 0) {
      return true;
    }
    const row = rows[0];
    if (row.expiresAt.getTime() <= Date.now()) {
      return true;
    }
    return row.revokedAt !== null;
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      throw error;
    }
    loggers.api.warn('JTI check failed: DB unavailable - treating as revoked');
    return true;
  }
}

/**
 * Revoke a specific JTI.
 *
 * Atomic single-statement UPDATE: sets `revoked_at = now()` only if the row
 * exists and has not expired. Returns false when the JTI was never recorded
 * or has already expired (matching prior Redis semantics). Idempotent —
 * re-revoking an already-revoked JTI resets `revoked_at` to now().
 *
 * SECURITY: In production, throws if DB unavailable (fail-closed).
 */
export async function revokeJTI(jti: string, reason: string): Promise<boolean> {
  try {
    const result = await db
      .update(revokedServiceTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(revokedServiceTokens.jti, jti),
          gt(revokedServiceTokens.expiresAt, sql`now()`),
        ),
      );

    const updated = (result.rowCount ?? 0) > 0;
    if (updated) {
      loggers.api.info('JTI revoked', { jti: '[REDACTED]', reason });
    }
    return updated;
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      throw error;
    }
    loggers.api.warn('JTI revocation skipped: DB unavailable');
    return false;
  }
}

/**
 * Delete revoked-JTI rows whose `expires_at` is in the past.
 * Runs on the cron sweeper; returns the number of rows deleted.
 *
 * Not fail-closed: the sweeper is best-effort cleanup. In production we
 * still re-throw so the cron handler can surface a 500 and page ops.
 */
export async function sweepExpiredRevokedJTIs(): Promise<number> {
  try {
    const result = await db
      .delete(revokedServiceTokens)
      .where(lt(revokedServiceTokens.expiresAt, sql`now()`));
    return result.rowCount ?? 0;
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      throw error;
    }
    loggers.api.warn('JTI sweep skipped: DB unavailable');
    return 0;
  }
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
