/**
 * Distributed Rate Limiting
 *
 * Redis-based rate limiting for production deployments with multiple instances.
 * Replaces the in-memory rate limiter for distributed systems.
 *
 * Features:
 * - Sliding window algorithm for accurate rate limiting
 * - Works across multiple server instances
 * - Progressive blocking for repeated violations
 * - Graceful fallback to in-memory in development
 *
 * @see packages/lib/src/auth/rate-limit-utils.ts for in-memory version
 */

import {
  checkRateLimit as redisCheckRateLimit,
  resetRateLimit as redisResetRateLimit,
  getRateLimitStatus as redisGetRateLimitStatus,
  tryGetRateLimitRedisClient,
} from './security-redis';
import { loggers } from '../logging/logger-config';

// =============================================================================
// Types
// =============================================================================

export interface RateLimitConfig {
  maxAttempts: number;
  windowMs: number;
  blockDurationMs?: number;
  progressiveDelay?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
  attemptsRemaining?: number;
}

// =============================================================================
// In-Memory Fallback (for development only)
// =============================================================================

interface InMemoryAttempt {
  count: number;
  firstAttempt: number;
  lastAttempt: number;
  blockedUntil?: number;
}

const inMemoryAttempts = new Map<string, InMemoryAttempt>();
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Start the cleanup interval for in-memory rate limiting.
 * Uses 2-hour cutoff to match longest rate limit window (1 hour) with buffer.
 */
function startCleanupInterval(): void {
  if (cleanupIntervalId) return;

  cleanupIntervalId = setInterval(() => {
    const now = Date.now();
    const cutoff = now - 2 * 60 * 60 * 1000; // 2 hours (matches longest window + buffer)

    for (const [key, attempt] of inMemoryAttempts.entries()) {
      if (attempt.lastAttempt < cutoff) {
        inMemoryAttempts.delete(key);
      }
    }
  }, 5 * 60 * 1000);
}

/**
 * Shutdown rate limiting cleanup.
 * Clears the interval and all in-memory data.
 * Call this during graceful shutdown to prevent memory leaks.
 */
export function shutdownRateLimiting(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
  inMemoryAttempts.clear();
}

// Auto-start cleanup on module load
if (typeof setInterval !== 'undefined') {
  startCleanupInterval();
}

function inMemoryCheckRateLimit(
  identifier: string,
  config: RateLimitConfig
): RateLimitResult {
  const now = Date.now();
  let attempt = inMemoryAttempts.get(identifier);

  if (!attempt) {
    attempt = { count: 1, firstAttempt: now, lastAttempt: now };
    inMemoryAttempts.set(identifier, attempt);
    return { allowed: true, attemptsRemaining: config.maxAttempts - 1 };
  }

  // Check if blocked
  if (attempt.blockedUntil && now < attempt.blockedUntil) {
    return {
      allowed: false,
      retryAfter: Math.ceil((attempt.blockedUntil - now) / 1000),
    };
  }

  // Block expired - reset
  if (attempt.blockedUntil && now >= attempt.blockedUntil) {
    attempt.count = 1;
    attempt.firstAttempt = now;
    attempt.lastAttempt = now;
    delete attempt.blockedUntil;
    return { allowed: true, attemptsRemaining: config.maxAttempts - 1 };
  }

  // Window expired - reset
  if (now - attempt.firstAttempt > config.windowMs) {
    attempt.count = 1;
    attempt.firstAttempt = now;
    attempt.lastAttempt = now;
    delete attempt.blockedUntil;
    return { allowed: true, attemptsRemaining: config.maxAttempts - 1 };
  }

  // Increment
  attempt.count++;
  attempt.lastAttempt = now;

  if (attempt.count <= config.maxAttempts) {
    return {
      allowed: true,
      attemptsRemaining: config.maxAttempts - attempt.count,
    };
  }

  // Rate limit exceeded - calculate block duration
  let blockDuration = config.blockDurationMs || config.windowMs;

  if (config.progressiveDelay) {
    const excessAttempts = attempt.count - config.maxAttempts;
    blockDuration = Math.min(
      blockDuration * Math.pow(2, excessAttempts - 1),
      30 * 60 * 1000 // Max 30 minutes
    );
  }

  attempt.blockedUntil = now + blockDuration;

  return {
    allowed: false,
    retryAfter: Math.ceil(blockDuration / 1000),
  };
}

function inMemoryResetRateLimit(identifier: string): void {
  inMemoryAttempts.delete(identifier);
}

function inMemoryGetRateLimitStatus(
  identifier: string,
  config: RateLimitConfig
): { blocked: boolean; retryAfter?: number; attemptsRemaining?: number } {
  const now = Date.now();
  const attempt = inMemoryAttempts.get(identifier);

  if (!attempt) {
    return { blocked: false, attemptsRemaining: config.maxAttempts };
  }

  if (attempt.blockedUntil && now < attempt.blockedUntil) {
    return {
      blocked: true,
      retryAfter: Math.ceil((attempt.blockedUntil - now) / 1000),
    };
  }

  if (now - attempt.firstAttempt > config.windowMs) {
    return { blocked: false, attemptsRemaining: config.maxAttempts };
  }

  return {
    blocked: attempt.count >= config.maxAttempts,
    attemptsRemaining: Math.max(0, config.maxAttempts - attempt.count),
  };
}

// =============================================================================
// Distributed Rate Limiting (Main API)
// =============================================================================

let redisAvailableLogged = false;

/**
 * Check rate limit for an identifier.
 * Uses Redis in production, falls back to in-memory in development.
 */
export async function checkDistributedRateLimit(
  identifier: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  // Try rate limit Redis client (uses REDIS_RATE_LIMIT_URL)
  const redis = await tryGetRateLimitRedisClient();

  if (redis) {
    if (!redisAvailableLogged) {
      loggers.api.info('Distributed rate limiting enabled (Redis)');
      redisAvailableLogged = true;
    }

    try {
      const result = await redisCheckRateLimit(
        identifier,
        config.maxAttempts,
        config.windowMs
      );

      // Handle progressive delay if configured
      if (!result.allowed && config.progressiveDelay) {
        const excessAttempts = result.totalCount - config.maxAttempts;
        const baseBlock = config.blockDurationMs || config.windowMs;
        const blockDuration = Math.min(
          baseBlock * Math.pow(2, Math.max(0, excessAttempts - 1)),
          30 * 60 * 1000
        );

        return {
          allowed: false,
          retryAfter: Math.ceil(blockDuration / 1000),
          attemptsRemaining: 0,
        };
      }

      return {
        allowed: result.allowed,
        retryAfter: result.allowed
          ? undefined
          : Math.ceil((result.resetAt.getTime() - Date.now()) / 1000),
        attemptsRemaining: result.remaining,
      };
    } catch (error) {
      loggers.api.warn('Redis rate limit check failed, falling back to in-memory', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Fall through to in-memory
    }
  }

  // Production: FAIL CLOSED - deny request if we can't properly rate limit
  if (process.env.NODE_ENV === 'production') {
    // Safe truncation that won't throw on short/undefined identifiers
    const safeId = String(identifier ?? '').slice(0, 20);
    // Compute retryAfter from the actual rate-limit window for this request
    const retryAfterSeconds = Math.ceil(config.windowMs / 1000);

    loggers.api.error('Redis unavailable in production - DENYING request (fail-closed)', {
      identifier: safeId.length >= 20 ? `${safeId}...` : safeId,
    });
    return {
      allowed: false,
      retryAfter: retryAfterSeconds,
      attemptsRemaining: 0,
    };
  }

  // Development only: fall back to in-memory (acceptable for single-instance dev)
  return inMemoryCheckRateLimit(identifier, config);
}

/**
 * Reset rate limit for an identifier (e.g., after successful auth).
 */
export async function resetDistributedRateLimit(identifier: string): Promise<void> {
  // Reset in both Redis and in-memory to be safe
  try {
    const redis = await tryGetRateLimitRedisClient();
    if (redis) {
      await redisResetRateLimit(identifier);
    }
  } catch (error) {
    loggers.api.debug('Redis rate limit reset failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  inMemoryResetRateLimit(identifier);
}

/**
 * Get rate limit status without incrementing.
 * In production, fails closed (reports blocked) when Redis is unavailable to avoid
 * returning potentially stale/incorrect in-memory status in distributed deployments.
 */
export async function getDistributedRateLimitStatus(
  identifier: string,
  config: RateLimitConfig
): Promise<{ blocked: boolean; retryAfter?: number; attemptsRemaining?: number }> {
  try {
    const redis = await tryGetRateLimitRedisClient();
    if (redis) {
      const result = await redisGetRateLimitStatus(
        identifier,
        config.maxAttempts,
        config.windowMs
      );

      return {
        blocked: !result.allowed,
        retryAfter: result.allowed
          ? undefined
          : Math.ceil((result.resetAt.getTime() - Date.now()) / 1000),
        attemptsRemaining: result.remaining,
      };
    }
  } catch {
    // Fall through to fail-closed/in-memory handling below
  }

  // Production: FAIL CLOSED - report as blocked when Redis unavailable
  // This prevents returning stale in-memory status in distributed deployments
  if (process.env.NODE_ENV === 'production') {
    return {
      blocked: true,
      retryAfter: Math.ceil(config.windowMs / 1000),
      attemptsRemaining: 0,
    };
  }

  // Development only: fall back to in-memory status
  return inMemoryGetRateLimitStatus(identifier, config);
}

// =============================================================================
// Predefined Rate Limit Configurations
// =============================================================================

export const DISTRIBUTED_RATE_LIMITS = {
  LOGIN: {
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000, // 15 minutes
    blockDurationMs: 15 * 60 * 1000,
    progressiveDelay: true,
  },
  SIGNUP: {
    maxAttempts: 3,
    windowMs: 60 * 60 * 1000, // 1 hour
    blockDurationMs: 60 * 60 * 1000,
    progressiveDelay: false,
  },
  PASSWORD_RESET: {
    maxAttempts: 3,
    windowMs: 60 * 60 * 1000, // 1 hour
    blockDurationMs: 60 * 60 * 1000,
    progressiveDelay: false,
  },
  REFRESH: {
    maxAttempts: 10,
    windowMs: 5 * 60 * 1000, // 5 minutes
    blockDurationMs: 5 * 60 * 1000,
    progressiveDelay: false,
  },
  OAUTH_VERIFY: {
    maxAttempts: 10,
    windowMs: 5 * 60 * 1000, // 5 minutes
    blockDurationMs: 5 * 60 * 1000,
    progressiveDelay: false,
  },
  API: {
    maxAttempts: 100,
    windowMs: 60 * 1000, // 1 minute
    blockDurationMs: 60 * 1000,
    progressiveDelay: false,
  },
  FILE_UPLOAD: {
    maxAttempts: 20,
    windowMs: 60 * 1000, // 1 minute
    blockDurationMs: 60 * 1000,
    progressiveDelay: false,
  },
  SERVICE_TOKEN: {
    maxAttempts: 1000,
    windowMs: 60 * 1000, // 1 minute
    blockDurationMs: 60 * 1000,
    progressiveDelay: false,
  },
} as const;

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize distributed rate limiting.
 * In production, this validates Redis is available.
 */
export async function initializeDistributedRateLimiting(): Promise<{
  mode: 'redis' | 'memory';
  error?: string;
}> {
  try {
    const redis = await tryGetRateLimitRedisClient();

    if (redis) {
      // Verify connection with a ping
      await redis.ping();
      loggers.api.info('Distributed rate limiting initialized with Redis');
      return { mode: 'redis' };
    }

    if (process.env.NODE_ENV === 'production') {
      const error = 'Redis required for distributed rate limiting in production';
      loggers.api.error(error);
      throw new Error(error);
    }

    loggers.api.warn('Distributed rate limiting using in-memory fallback (development only)');
    return { mode: 'memory' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    loggers.api.error('Failed to initialize distributed rate limiting', { error: message });

    if (process.env.NODE_ENV === 'production') {
      throw error;
    }

    return { mode: 'memory' };
  }
}
