/**
 * Distributed Rate Limiting
 *
 * Postgres-backed fixed-bucket rate limiter for production deployments with
 * multiple instances.
 *
 * Storage: `rate_limit_buckets (key, window_start) → count`.
 * Counter: `INSERT ... ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count`
 * is a single atomic round-trip; concurrent requests against the same bucket
 * serialize on the row lock Postgres takes during the UPDATE.
 *
 * Features:
 * - Fixed window-start alignment so repeated calls within a window share a counter
 * - Works across multiple server instances (Postgres is the source of truth)
 * - Progressive blocking for repeated violations (computed at call time)
 * - Graceful fallback to in-memory in development when DB is unreachable
 * - Fail-closed in production: deny with Retry-After when DB is unreachable
 *
 * @see packages/lib/src/auth/rate-limit-utils.ts for the in-memory-only version
 */

import { db, rateLimitBuckets, sql, eq } from '@pagespace/db';
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
 * Uses 25-hour cutoff to match longest rate limit window (EXPORT_DATA 24h) with buffer.
 */
function startCleanupInterval(): void {
  if (cleanupIntervalId) return;

  cleanupIntervalId = setInterval(() => {
    const now = Date.now();
    const cutoff = now - 25 * 60 * 60 * 1000;

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

  if (attempt.blockedUntil && now < attempt.blockedUntil) {
    return {
      allowed: false,
      retryAfter: Math.ceil((attempt.blockedUntil - now) / 1000),
    };
  }

  if (attempt.blockedUntil && now >= attempt.blockedUntil) {
    attempt.count = 1;
    attempt.firstAttempt = now;
    attempt.lastAttempt = now;
    delete attempt.blockedUntil;
    return { allowed: true, attemptsRemaining: config.maxAttempts - 1 };
  }

  if (now - attempt.firstAttempt > config.windowMs) {
    attempt.count = 1;
    attempt.firstAttempt = now;
    attempt.lastAttempt = now;
    delete attempt.blockedUntil;
    return { allowed: true, attemptsRemaining: config.maxAttempts - 1 };
  }

  attempt.count++;
  attempt.lastAttempt = now;

  if (attempt.count <= config.maxAttempts) {
    return {
      allowed: true,
      attemptsRemaining: config.maxAttempts - attempt.count,
    };
  }

  let blockDuration = config.blockDurationMs || config.windowMs;

  if (config.progressiveDelay) {
    const excessAttempts = attempt.count - config.maxAttempts;
    blockDuration = Math.min(
      blockDuration * Math.pow(2, excessAttempts - 1),
      30 * 60 * 1000
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

let postgresAvailableLogged = false;

// Fail-closed response when DB is unavailable in production.
function failClosedResponse(config: RateLimitConfig): RateLimitResult {
  return {
    allowed: false,
    retryAfter: Math.ceil(config.windowMs / 1000),
    attemptsRemaining: 0,
  };
}

// Bucket-aligned window_start for the current time.
function currentWindowStart(windowMs: number, now: number = Date.now()): Date {
  return new Date(Math.floor(now / windowMs) * windowMs);
}

// Progressive block duration, clamped to the 30-minute ceiling and to the
// time remaining in the current bucket. A fixed-window Postgres bucket resets
// at windowStart + windowMs; any retryAfter beyond that is a promise we can't keep.
function computeProgressiveBlockMs(
  count: number,
  config: RateLimitConfig,
  windowStart: Date,
  now: number,
): number {
  const excessAttempts = count - config.maxAttempts;
  const baseBlock = config.blockDurationMs || config.windowMs;
  const uncapped = baseBlock * Math.pow(2, Math.max(0, excessAttempts - 1));
  const msUntilWindowEnd = Math.max(0, windowStart.getTime() + config.windowMs - now);
  return Math.min(uncapped, 30 * 60 * 1000, msUntilWindowEnd);
}

/**
 * Check rate limit for an identifier.
 * Uses Postgres in production, falls back to in-memory in development when DB is down.
 */
export async function checkDistributedRateLimit(
  identifier: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = currentWindowStart(config.windowMs, now);
  const expiresAt = new Date(windowStart.getTime() + config.windowMs);

  try {
    const rows = await db
      .insert(rateLimitBuckets)
      .values({
        key: identifier,
        windowStart,
        count: 1,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [rateLimitBuckets.key, rateLimitBuckets.windowStart],
        set: { count: sql`${rateLimitBuckets.count} + 1` },
      })
      .returning({ count: rateLimitBuckets.count });

    const count = rows[0]?.count ?? 0;

    if (!postgresAvailableLogged) {
      loggers.api.info('Distributed rate limiting enabled (Postgres)');
      postgresAvailableLogged = true;
    }

    if (count <= config.maxAttempts) {
      return {
        allowed: true,
        attemptsRemaining: config.maxAttempts - count,
      };
    }

    if (config.progressiveDelay) {
      const blockDuration = computeProgressiveBlockMs(count, config, windowStart, now);
      return {
        allowed: false,
        retryAfter: Math.ceil(blockDuration / 1000),
        attemptsRemaining: 0,
      };
    }

    return {
      allowed: false,
      retryAfter: Math.ceil(config.windowMs / 1000),
      attemptsRemaining: 0,
    };
  } catch (error) {
    loggers.api.warn('Postgres rate limit check failed, falling back', {
      error: error instanceof Error ? error.message : String(error),
    });

    if (process.env.NODE_ENV === 'production') {
      const safeId = String(identifier ?? '').slice(0, 20);
      loggers.api.error('Postgres unavailable in production - DENYING request (fail-closed)', {
        identifier: safeId.length >= 20 ? `${safeId}...` : safeId,
      });
      return failClosedResponse(config);
    }

    return inMemoryCheckRateLimit(identifier, config);
  }
}

/**
 * Reset rate limit for an identifier (e.g., after successful auth).
 */
export async function resetDistributedRateLimit(identifier: string): Promise<void> {
  try {
    await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.key, identifier));
  } catch (error) {
    loggers.api.debug('Postgres rate limit reset failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  inMemoryResetRateLimit(identifier);
}

/**
 * Get rate limit status without incrementing.
 * In production, fails closed (reports blocked) when DB is unavailable to avoid
 * returning potentially stale in-memory status in distributed deployments.
 */
export async function getDistributedRateLimitStatus(
  identifier: string,
  config: RateLimitConfig
): Promise<{ blocked: boolean; retryAfter?: number; attemptsRemaining?: number }> {
  const now = Date.now();
  const windowStart = currentWindowStart(config.windowMs, now);

  try {
    const rows = await db
      .select({ count: rateLimitBuckets.count })
      .from(rateLimitBuckets)
      .where(
        sql`${rateLimitBuckets.key} = ${identifier} AND ${rateLimitBuckets.windowStart} = ${windowStart}`
      )
      .limit(1);

    const count = rows[0]?.count ?? 0;
    const blocked = count >= config.maxAttempts;

    let retryAfter: number | undefined;
    if (blocked) {
      const blockMs = config.progressiveDelay
        ? computeProgressiveBlockMs(count, config, windowStart, now)
        : config.windowMs;
      retryAfter = Math.ceil(blockMs / 1000);
    }

    return {
      blocked,
      retryAfter,
      attemptsRemaining: Math.max(0, config.maxAttempts - count),
    };
  } catch {
    if (process.env.NODE_ENV === 'production') {
      return {
        blocked: true,
        retryAfter: Math.ceil(config.windowMs / 1000),
        attemptsRemaining: 0,
      };
    }

    return inMemoryGetRateLimitStatus(identifier, config);
  }
}

// =============================================================================
// Predefined Rate Limit Configurations
// =============================================================================

export const DISTRIBUTED_RATE_LIMITS = {
  LOGIN: {
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 15 * 60 * 1000,
    progressiveDelay: true,
  },
  SIGNUP: {
    maxAttempts: 10,
    windowMs: 60 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000,
    progressiveDelay: false,
  },
  PASSWORD_RESET: {
    maxAttempts: 3,
    windowMs: 60 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000,
    progressiveDelay: false,
  },
  REFRESH: {
    maxAttempts: 10,
    windowMs: 5 * 60 * 1000,
    blockDurationMs: 5 * 60 * 1000,
    progressiveDelay: false,
  },
  OAUTH_VERIFY: {
    maxAttempts: 10,
    windowMs: 5 * 60 * 1000,
    blockDurationMs: 5 * 60 * 1000,
    progressiveDelay: false,
  },
  API: {
    maxAttempts: 100,
    windowMs: 60 * 1000,
    blockDurationMs: 60 * 1000,
    progressiveDelay: false,
  },
  FILE_UPLOAD: {
    maxAttempts: 20,
    windowMs: 60 * 1000,
    blockDurationMs: 60 * 1000,
    progressiveDelay: false,
  },
  SERVICE_TOKEN: {
    maxAttempts: 1000,
    windowMs: 60 * 1000,
    blockDurationMs: 60 * 1000,
    progressiveDelay: false,
  },
  CONTACT_FORM: {
    maxAttempts: 10,
    windowMs: 60 * 1000,
    blockDurationMs: 60 * 1000,
    progressiveDelay: false,
  },
  MARKETING_CONTACT_FORM: {
    maxAttempts: 5,
    windowMs: 60 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000,
    progressiveDelay: false,
  },
  TRACKING: {
    maxAttempts: 100,
    windowMs: 60 * 1000,
    blockDurationMs: 60 * 1000,
    progressiveDelay: false,
  },
  EMAIL_RESEND: {
    maxAttempts: 3,
    windowMs: 60 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000,
    progressiveDelay: false,
  },
  EXPORT_DATA: {
    maxAttempts: 1,
    windowMs: 24 * 60 * 60 * 1000,
    blockDurationMs: 24 * 60 * 60 * 1000,
    progressiveDelay: false,
  },
  MAGIC_LINK: {
    maxAttempts: 3,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 15 * 60 * 1000,
    progressiveDelay: true,
  },
  PASSKEY_REGISTER: {
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 15 * 60 * 1000,
    progressiveDelay: false,
  },
  PASSKEY_AUTH: {
    maxAttempts: 10,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 15 * 60 * 1000,
    progressiveDelay: false,
  },
  PASSKEY_OPTIONS: {
    maxAttempts: 30,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 15 * 60 * 1000,
    progressiveDelay: false,
  },
} as const;

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize distributed rate limiting.
 * Validates that Postgres is reachable; in production, throws if not.
 */
export async function initializeDistributedRateLimiting(): Promise<{
  mode: 'postgres' | 'memory';
  error?: string;
}> {
  try {
    await db.execute(sql`SELECT 1`);
    loggers.api.info('Distributed rate limiting initialized with Postgres');
    return { mode: 'postgres' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    loggers.api.error('Failed to initialize distributed rate limiting', { error: message });

    if (process.env.NODE_ENV === 'production') {
      throw error instanceof Error
        ? error
        : new Error('Postgres required for distributed rate limiting in production');
    }

    loggers.api.warn('Distributed rate limiting using in-memory fallback (development only)');
    return { mode: 'memory' };
  }
}
