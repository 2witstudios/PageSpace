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
 * - Degraded-but-enforcing in production: when the DB is unreachable, each
 *   instance enforces a CONSERVATIVE in-memory limit (half the configured
 *   threshold) so a DB outage neither becomes a total platform outage
 *   (fail-closed shared fate) nor a rate-limit bypass (fail-open). Only if
 *   the in-memory check itself fails does the request fail closed. The
 *   in-memory store is bounded (per-entry expiry sweep + hard identifier cap)
 *   so an identifier flood during the outage cannot OOM the process.
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
  /** When this entry is dead weight: end of its window or of any active block. */
  expiresAt: number;
}

const inMemoryAttempts = new Map<string, InMemoryAttempt>();
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Hard cap on distinct identifiers tracked in memory (~250 bytes/entry →
 * ~12 MB worst case). The store is production-reachable during a Postgres
 * outage, where an attacker can spray arbitrary identifiers (emails, client
 * IDs) at unauthenticated endpoints; without a cap that turns the DB incident
 * into an application OOM. When full, the entry closest to expiry among the
 * oldest-inserted few is evicted: resetting a stale counter early slightly
 * loosens limiting under an active identifier flood, but identifier rotation
 * already defeats per-identifier limits, whereas unbounded growth defeats the
 * availability goal of the fallback itself.
 */
export const MAX_IN_MEMORY_ATTEMPT_ENTRIES = 50_000;

// How many of the oldest entries to consider when the store is full. Bounds
// eviction cost per insert while still strongly preferring window-only entries
// (near expiry) over actively blocked ones (expiry extended to block end) —
// evicting a live block would let an attacker flush their own block by
// spraying fresh identifiers.
const EVICTION_SCAN_LIMIT = 16;

/**
 * Evict one entry to admit a new identifier when the store is at capacity.
 * Scans the oldest EVICTION_SCAN_LIMIT entries (Map iteration is
 * insertion-ordered) and deletes the one closest to expiry; anything already
 * expired wins immediately. Blocks survive because their expiresAt extends to
 * the block end, sorting them behind ordinary window entries.
 */
function evictForCapacity(now: number): void {
  let victimKey: string | undefined;
  let victimExpiry = Infinity;
  let scanned = 0;
  for (const [key, attempt] of inMemoryAttempts.entries()) {
    if (scanned >= EVICTION_SCAN_LIMIT) break;
    scanned++;
    if (now >= attempt.expiresAt) {
      victimKey = key;
      break;
    }
    if (attempt.expiresAt < victimExpiry) {
      victimExpiry = attempt.expiresAt;
      victimKey = key;
    }
  }
  if (victimKey !== undefined) {
    inMemoryAttempts.delete(victimKey);
  }
}

/**
 * Delete entries whose window AND any block have fully elapsed. Never evicts
 * an actively blocked entry — that would reset its counter and void the block.
 * Exported for tests; production runs it on the cleanup interval.
 */
export function sweepExpiredInMemoryAttempts(now: number = Date.now()): number {
  let evicted = 0;
  for (const [key, attempt] of inMemoryAttempts.entries()) {
    if (now >= attempt.expiresAt) {
      inMemoryAttempts.delete(key);
      evicted++;
    }
  }
  return evicted;
}

/**
 * Start the cleanup interval for in-memory rate limiting.
 * Evicts by per-entry expiry (window/block end), so a 1-minute API bucket is
 * reclaimed in minutes while the 24h EXPORT_DATA bucket still survives its
 * full window.
 */
function startCleanupInterval(): void {
  if (cleanupIntervalId) return;

  cleanupIntervalId = setInterval(() => {
    sweepExpiredInMemoryAttempts();
  }, 5 * 60 * 1000);

  // Don't let the sweep keep the process alive (no-op outside Node).
  (cleanupIntervalId as { unref?: () => unknown }).unref?.();
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
  // Match PG-up semantics for a degenerate zero/negative limit: with PG up,
  // the first attempt already exceeds maxAttempts 0, so everything is denied.
  // The fallback must never be looser than the configured limit.
  if (config.maxAttempts < 1) {
    return {
      allowed: false,
      retryAfter: Math.ceil(config.windowMs / 1000),
      attemptsRemaining: 0,
    };
  }

  const now = Date.now();
  let attempt = inMemoryAttempts.get(identifier);

  if (!attempt) {
    if (inMemoryAttempts.size >= MAX_IN_MEMORY_ATTEMPT_ENTRIES) {
      evictForCapacity(now);
    }
    // Re-arm the expiry sweep if a shutdown cleared it and traffic resumed —
    // without this, only the capacity cap would bound the store afterwards.
    startCleanupInterval();
    attempt = {
      count: 1,
      firstAttempt: now,
      lastAttempt: now,
      expiresAt: now + config.windowMs,
    };
    inMemoryAttempts.set(identifier, attempt);
    return { allowed: true, attemptsRemaining: config.maxAttempts - 1 };
  }

  if (attempt.blockedUntil && now < attempt.blockedUntil) {
    return {
      allowed: false,
      retryAfter: Math.ceil((attempt.blockedUntil - now) / 1000),
    };
  }

  if (
    (attempt.blockedUntil && now >= attempt.blockedUntil) ||
    now - attempt.firstAttempt > config.windowMs
  ) {
    attempt.count = 1;
    attempt.firstAttempt = now;
    attempt.lastAttempt = now;
    attempt.expiresAt = now + config.windowMs;
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
  attempt.expiresAt = Math.max(attempt.expiresAt, attempt.blockedUntil);

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

/**
 * Conservative per-instance threshold used while Postgres is unreachable in
 * production. Half the configured limit (floor 1): the in-memory fallback is
 * per-instance, so with N instances an attacker spraying evenly could reach
 * N × this value — halving claws back headroom against that multiplier while
 * still letting legitimate users through. Never exceeds the configured limit
 * (a degenerate configured 0 stays 0).
 */
export function conservativeFallbackMaxAttempts(maxAttempts: number): number {
  return Math.min(maxAttempts, Math.max(1, Math.floor(maxAttempts / 2)));
}

/**
 * Same window/block semantics as the caller's config, with only maxAttempts
 * reduced to the conservative per-instance threshold.
 */
export function conservativeFallbackConfig(config: RateLimitConfig): RateLimitConfig {
  return { ...config, maxAttempts: conservativeFallbackMaxAttempts(config.maxAttempts) };
}

/**
 * Production fallback when Postgres is unreachable: enforce the conservative
 * in-memory limit instead of denying every request (a fail-closed check that
 * shares fate with the primary DB turns a DB stall into a total platform
 * outage). Limits stay at or below configured — never fail open. If the
 * in-memory check itself throws, we genuinely cannot limit, so fail closed.
 *
 * `memCheck` is injectable for tests; production callers use the default.
 */
export function conservativeFallbackCheck(
  identifier: string,
  config: RateLimitConfig,
  memCheck: (identifier: string, config: RateLimitConfig) => RateLimitResult = inMemoryCheckRateLimit,
): RateLimitResult {
  const safeId = String(identifier ?? '').slice(0, 20);
  const logId = safeId.length >= 20 ? `${safeId}...` : safeId;

  try {
    const result = memCheck(identifier, conservativeFallbackConfig(config));
    loggers.api.warn(
      'RATE_LIMIT_PG_FALLBACK: Postgres unavailable in production - enforcing conservative per-instance in-memory limit',
      { identifier: logId, allowed: result.allowed },
    );
    return result;
  } catch {
    loggers.api.error('Postgres unavailable in production - DENYING request (fail-closed)', {
      identifier: logId,
    });
    return failClosedResponse(config);
  }
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

    // Re-arm the mode log so recovery ("Distributed rate limiting enabled")
    // is visible in logs after an outage.
    postgresAvailableLogged = false;

    if (process.env.NODE_ENV === 'production') {
      return conservativeFallbackCheck(identifier, config);
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
 * In production, when the DB is unavailable this reports the same conservative
 * per-instance in-memory state the check path enforces during the outage, so
 * status and enforcement agree; it fails closed (reports blocked) only if the
 * in-memory read itself throws.
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
      try {
        return inMemoryGetRateLimitStatus(identifier, conservativeFallbackConfig(config));
      } catch {
        return {
          blocked: true,
          retryAfter: Math.ceil(config.windowMs / 1000),
          attemptsRemaining: 0,
        };
      }
    }

    return inMemoryGetRateLimitStatus(identifier, config);
  }
}

/**
 * Increment and return the authentication-failure count for an identifier in
 * the current window. Reuses the `rate_limit_buckets` table with an
 * `authfail:` key prefix so the count survives restarts and spans replicas
 * (#977) — feeding the pure auth-anomaly detector.
 *
 * Best-effort: returns 0 on DB error, so the caller treats an unknown count as
 * "no anomaly" rather than failing the auth request.
 */
export async function countAuthFailure(identifier: string, windowMs: number): Promise<number> {
  const now = Date.now();
  const windowStart = currentWindowStart(windowMs, now);
  const expiresAt = new Date(windowStart.getTime() + 2 * windowMs);
  const key = `authfail:${identifier}`;

  try {
    const rows = await db
      .insert(rateLimitBuckets)
      .values({ key, windowStart, count: 1, expiresAt })
      .onConflictDoUpdate({
        target: [rateLimitBuckets.key, rateLimitBuckets.windowStart],
        set: { count: sql`${rateLimitBuckets.count} + 1` },
      })
      .returning({ count: rateLimitBuckets.count });
    return rows[0]?.count ?? 0;
  } catch (error) {
    loggers.api.warn('countAuthFailure failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
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
  // Public Canvas-form submission (/api/public/forms/[token]/submit): generous
  // enough for a real visitor retrying a validation error, tight enough to
  // blunt scripted spam against a specific form token. Callers also key a
  // secondary limit on the token prefix (see the route) so a single leaked
  // token can't be hammered from many IPs to bypass the per-IP limit here.
  FORM_SUBMISSION: {
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
  DRIVE_INVITE: {
    maxAttempts: 3,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 15 * 60 * 1000,
    progressiveDelay: false,
  },
  DRIVE_INVITE_RESEND: {
    maxAttempts: 3,
    windowMs: 24 * 60 * 60 * 1000,
    blockDurationMs: 24 * 60 * 60 * 1000,
    progressiveDelay: false,
  },
  CONNECTION_INVITE: {
    maxAttempts: 3,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 15 * 60 * 1000,
    progressiveDelay: false,
  },
  PAGE_SHARE_INVITE: {
    maxAttempts: 3,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 15 * 60 * 1000,
    progressiveDelay: false,
  },
  // OAuth /authorize: GET is the unauthenticated client_id/redirect_uri
  // probing surface (open-redirect reconnaissance); POST is the session-gated
  // consent decision. Generous enough for a human clicking through the flow
  // more than once, tight enough to blunt scripted enumeration.
  OAUTH_AUTHORIZE: {
    maxAttempts: 20,
    windowMs: 5 * 60 * 1000,
    blockDurationMs: 5 * 60 * 1000,
    progressiveDelay: false,
  },
  // OAuth /token authorization_code + refresh_token grants: each presents a
  // high-entropy secret exactly once per legitimate grant, so real traffic is
  // rare. Tight + progressive to blunt brute-forcing a code/refresh token.
  OAUTH_TOKEN_EXCHANGE: {
    maxAttempts: 10,
    windowMs: 5 * 60 * 1000,
    blockDurationMs: 5 * 60 * 1000,
    progressiveDelay: true,
  },
  // OAuth /token device_code polling: RFC 8628 expects ~1 poll per
  // pollIntervalSeconds (5s) from a single legitimate flow — that's already
  // throttled by decideDevicePoll's own per-record slow_down. This is an
  // endpoint-level backstop against a client ignoring slow_down or scanning
  // device codes wholesale, so it sits above single-flow polling volume.
  OAUTH_DEVICE_POLL: {
    maxAttempts: 100,
    windowMs: 5 * 60 * 1000,
    blockDurationMs: 60 * 1000,
    progressiveDelay: false,
  },
  // OAuth /device_authorization: unauthenticated device/user-code minting.
  // Limits mass code generation that would exhaust the short user-code space
  // or flood the device_authorizations table.
  OAUTH_DEVICE_INIT: {
    maxAttempts: 10,
    windowMs: 5 * 60 * 1000,
    blockDurationMs: 5 * 60 * 1000,
    progressiveDelay: false,
  },
  // OAuth /revoke: unauthenticated by design (RFC 7009 forbids an oracle on
  // outcome), so rate limiting is the only defense against endpoint flooding.
  OAUTH_REVOKE: {
    maxAttempts: 20,
    windowMs: 5 * 60 * 1000,
    blockDurationMs: 5 * 60 * 1000,
    progressiveDelay: false,
  },
  // Per-webhook cap on posted channel messages (key: `page-webhook:{webhookId}`).
  // Meant to blunt abuse/runaway senders, not throttle legitimate bursty use —
  // matches Discord's own per-webhook limit (30 posts/min). A flooding caller
  // just gets error results; there is deliberately no dedupe/summary machinery.
  PAGE_WEBHOOK: {
    maxAttempts: 30,
    windowMs: 60 * 1000,
    blockDurationMs: 60 * 1000,
    progressiveDelay: false,
  },
  // Per-trigger cap on page-webhook-fired workflow runs (key:
  // `page-webhook-trigger:{triggerId}`). Deliberately far TIGHTER than the
  // 30/min PAGE_WEBHOOK channel-post limit: a fired trigger runs an agent
  // (LLM calls, tool use) that costs on the order of 1000x a single channel
  // message insert, so a runaway sender must be throttled hard here — on top
  // of executeWorkflow's single-running claim, which already serializes runs
  // of the same workflow but does not bound their rate over time.
  PAGE_WEBHOOK_TRIGGER: {
    maxAttempts: 5,
    windowMs: 60 * 1000,
    blockDurationMs: 60 * 1000,
    progressiveDelay: false,
  },
  // Per-WEBHOOK budget on AI runs (key: `page-webhook-ai-budget:{webhookId}`),
  // consumed once per attempted trigger run. The per-trigger bucket above
  // cannot bound aggregate spend: one webhook can bind up to 100 triggers,
  // each with its own 5/min bucket (500 runs/min). The webhook secret is a
  // bearer credential handed to external systems, so a leak must stay a
  // capped incident — this ceiling bounds ALL runs a leaked secret can force
  // through one webhook, regardless of how many triggers it fans out to.
  PAGE_WEBHOOK_AI_BUDGET: {
    maxAttempts: 60,
    windowMs: 60 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000,
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
