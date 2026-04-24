/**
 * Distributed Rate Limiting
 *
 * Postgres-backed weighted-sliding-window rate limiter for production
 * deployments with multiple instances.
 *
 * Storage: `rate_limit_buckets (key, window_start) → count`.
 *
 * Algorithm (two-bucket weighted sliding window):
 * - Each check atomically increments the current bucket via
 *   `INSERT ... ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count`
 *   (single round-trip; concurrent writers serialize on the row lock).
 * - In parallel it reads the previous bucket (windowStart - windowMs).
 * - Effective count = currCount + prevCount * (1 - msIntoBucket / windowMs).
 *   This is the Cloudflare/nginx sliding-window approximation: it smooths the
 *   bucket boundary so an attacker cannot burst maxAttempts right before a
 *   boundary and maxAttempts right after it.
 *
 * Rows live for 2×windowMs (expires_at = windowStart + 2*windowMs) so the
 * previous bucket is still readable until it has rolled entirely out of the
 * current window.
 *
 * Features:
 * - Weighted sliding window prevents boundary bursting (≈ Redis semantics)
 * - Works across multiple server instances (Postgres is the source of truth)
 * - Progressive blocking for repeated violations (computed at call time)
 * - Graceful fallback to in-memory in development when DB is unreachable
 * - Fail-closed in production: deny with Retry-After when DB is unreachable
 *
 * @see packages/lib/src/auth/rate-limit-utils.ts for the in-memory-only version
 */

import { db } from '@pagespace/db/db';
import { sql, eq, lt } from '@pagespace/db/operators';
import { rateLimitBuckets } from '@pagespace/db/schema/rate-limit-buckets';
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

// Weighted sliding-window count: current bucket plus a decaying contribution
// from the previous bucket. As `now` advances through the current bucket, the
// previous bucket's weight drops linearly from 1 → 0.
function computeEffectiveCount(
  currCount: number,
  prevCount: number,
  windowStart: Date,
  now: number,
  windowMs: number,
): number {
  const msIntoBucket = Math.max(0, Math.min(windowMs, now - windowStart.getTime()));
  const prevWeight = 1 - msIntoBucket / windowMs;
  return currCount + prevCount * prevWeight;
}

// Progressive block duration, clamped to the 30-minute ceiling and to the
// time remaining in the current bucket. A fixed-window Postgres bucket resets
// at windowStart + windowMs; any retryAfter beyond that is a promise we can't keep.
function computeProgressiveBlockMs(
  effectiveCount: number,
  config: RateLimitConfig,
  windowStart: Date,
  now: number,
): number {
  // Fractional excess is possible (effective count includes a weighted prev
  // bucket). Round up so any overage incurs at least the base penalty.
  const excessAttempts = Math.max(0, Math.ceil(effectiveCount - config.maxAttempts));
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
  const prevWindowStart = new Date(windowStart.getTime() - config.windowMs);
  // expires_at covers 2 windows so the previous bucket survives long enough
  // for the sliding-window read below to see it.
  const expiresAt = new Date(windowStart.getTime() + 2 * config.windowMs);

  try {
    const [currRows, prevRows] = await Promise.all([
      db
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
        .returning({ count: rateLimitBuckets.count }),
      db
        .select({ count: rateLimitBuckets.count })
        .from(rateLimitBuckets)
        .where(
          sql`${rateLimitBuckets.key} = ${identifier} AND ${rateLimitBuckets.windowStart} = ${prevWindowStart}`
        )
        .limit(1),
    ]);

    const currCount = currRows[0]?.count ?? 0;
    const prevCount = prevRows[0]?.count ?? 0;
    const effectiveCount = computeEffectiveCount(
      currCount,
      prevCount,
      windowStart,
      now,
      config.windowMs,
    );

    if (!postgresAvailableLogged) {
      loggers.api.info('Distributed rate limiting enabled (Postgres)');
      postgresAvailableLogged = true;
    }

    if (effectiveCount <= config.maxAttempts) {
      return {
        allowed: true,
        attemptsRemaining: Math.max(
          0,
          Math.ceil(config.maxAttempts - effectiveCount),
        ),
      };
    }

    if (config.progressiveDelay) {
      const blockDuration = computeProgressiveBlockMs(effectiveCount, config, windowStart, now);
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
  const prevWindowStart = new Date(windowStart.getTime() - config.windowMs);

  try {
    const [currRows, prevRows] = await Promise.all([
      db
        .select({ count: rateLimitBuckets.count })
        .from(rateLimitBuckets)
        .where(
          sql`${rateLimitBuckets.key} = ${identifier} AND ${rateLimitBuckets.windowStart} = ${windowStart}`
        )
        .limit(1),
      db
        .select({ count: rateLimitBuckets.count })
        .from(rateLimitBuckets)
        .where(
          sql`${rateLimitBuckets.key} = ${identifier} AND ${rateLimitBuckets.windowStart} = ${prevWindowStart}`
        )
        .limit(1),
    ]);

    const currCount = currRows[0]?.count ?? 0;
    const prevCount = prevRows[0]?.count ?? 0;
    const effectiveCount = computeEffectiveCount(
      currCount,
      prevCount,
      windowStart,
      now,
      config.windowMs,
    );
    const blocked = effectiveCount >= config.maxAttempts;

    let retryAfter: number | undefined;
    if (blocked) {
      const blockMs = config.progressiveDelay
        ? computeProgressiveBlockMs(effectiveCount, config, windowStart, now)
        : config.windowMs;
      retryAfter = Math.ceil(blockMs / 1000);
    }

    return {
      blocked,
      retryAfter,
      attemptsRemaining: Math.max(
        0,
        Math.ceil(config.maxAttempts - effectiveCount),
      ),
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

/**
 * Delete expired rate-limit buckets (`expires_at < now()`).
 *
 * Best-effort cleanup. In production, rethrows so the cron handler surfaces a
 * 500 and pages ops. Uses `rowCount` instead of `.returning()` so the return
 * is constant-size regardless of how many rows were deleted.
 *
 * Mirrors `sweepExpiredRevokedJTIs` in `./jti-revocation.ts`.
 */
export async function sweepExpiredRateLimitBuckets(): Promise<number> {
  try {
    const result = await db
      .delete(rateLimitBuckets)
      .where(lt(rateLimitBuckets.expiresAt, sql`now()`));
    return result.rowCount ?? 0;
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      throw error;
    }
    loggers.api.warn('Rate-limit bucket sweep skipped: DB unavailable');
    return 0;
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
