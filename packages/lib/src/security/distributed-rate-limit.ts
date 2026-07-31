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

import { createHash } from 'crypto';
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

// Longest identifier stored verbatim as a Map key. Unauthenticated callers
// control identifier content (e.g. OAuth client_id), so without a byte bound
// the 50k entry cap is not a memory bound — 10KB identifiers at the cap are
// ~500MB. Oversized identifiers are HASHED, not truncated: distinct inputs
// stay distinct, and equal inputs keep sharing one counter.
export const MAX_IDENTIFIER_KEY_LENGTH = 128;

export function boundedIdentifier(identifier: string): string {
  if (identifier.length <= MAX_IDENTIFIER_KEY_LENGTH) {
    return identifier;
  }
  // sha256 is deliberate and correct here despite identifiers possibly
  // deriving from credentials (CodeQL js/insufficient-password-hash flags
  // this): the digest is an in-memory Map KEY for rate-limit counting — never
  // persisted, never used to verify anything — and the alternative stored the
  // RAW identifier, which is strictly worse. A slow password KDF would itself
  // be a DoS vector on this per-request hot path.
  return `h:${createHash('sha256').update(identifier).digest('hex')}`;
}

/**
 * Hard cap on distinct identifiers tracked in memory (~250 bytes/entry →
 * ~12 MB worst case). The store is production-reachable during a Postgres
 * outage, where an attacker can spray arbitrary identifiers (emails, client
 * IDs) at unauthenticated endpoints; without a cap that turns the DB incident
 * into an application OOM. At capacity, only EXPIRED entries are reclaimed;
 * if every tracked window is still active, previously unseen identifiers are
 * conservatively denied instead — evicting an active entry would let an
 * attacker rotating identifiers reset a victim's counter or flush their own
 * block. Denial at capacity only occurs under an extreme identifier flood and
 * self-heals as tracked windows expire.
 */
export const MAX_IN_MEMORY_ATTEMPT_ENTRIES = 50_000;

// How many of the oldest entries (Map iteration is insertion-ordered, so
// expired entries cluster at the old end) to scan for a reclaimable slot on
// each at-capacity insert. Bounds per-request cost during a flood.
const EVICTION_SCAN_LIMIT = 16;

// A full-map sweep from the insert path is O(cap); allow at most one per
// second so a flood cannot turn every request into a 50k-entry scan.
const INLINE_SWEEP_MIN_INTERVAL_MS = 1_000;
let lastInlineSweepAt = 0;

/**
 * Try to free a slot for a new identifier when the store is at capacity.
 * Reclaims expired entries only — active counters and blocks are never
 * sacrificed. Cheap bounded scan of the oldest entries first, then at most
 * one throttled full sweep. Returns whether a slot was freed.
 */
function tryReclaimCapacity(now: number): boolean {
  let scanned = 0;
  for (const [key, attempt] of inMemoryAttempts.entries()) {
    if (scanned >= EVICTION_SCAN_LIMIT) break;
    scanned++;
    if (now >= attempt.expiresAt) {
      inMemoryAttempts.delete(key);
      return true;
    }
  }
  if (now - lastInlineSweepAt >= INLINE_SWEEP_MIN_INTERVAL_MS) {
    lastInlineSweepAt = now;
    return sweepExpiredInMemoryAttempts(now) > 0;
  }
  return false;
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
  lastInlineSweepAt = 0;
  lastFallbackWarnAt = 0;
  suppressedFallbackWarns = 0;
  closePgCircuit();
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

  const key = boundedIdentifier(identifier);
  const now = Date.now();
  let attempt = inMemoryAttempts.get(key);

  if (!attempt) {
    if (
      inMemoryAttempts.size >= MAX_IN_MEMORY_ATTEMPT_ENTRIES &&
      !tryReclaimCapacity(now)
    ) {
      // Full of active windows/blocks: deny the unseen identifier rather than
      // resetting someone else's active limit (see MAX_IN_MEMORY_ATTEMPT_ENTRIES).
      return {
        allowed: false,
        retryAfter: Math.ceil(config.windowMs / 1000),
        attemptsRemaining: 0,
      };
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
    inMemoryAttempts.set(key, attempt);
    return { allowed: true, attemptsRemaining: config.maxAttempts - 1 };
  }

  if (attempt.blockedUntil && now < attempt.blockedUntil) {
    return {
      allowed: false,
      retryAfter: Math.ceil((attempt.blockedUntil - now) / 1000),
    };
  }

  // An expired block only lifts the block — the window counter persists. A
  // full reset here would let a config with blockDurationMs < windowMs (e.g.
  // OAUTH_DEVICE_POLL: 5min window, 1min block) hand out a fresh allowance
  // every block period, compounding past even the configured per-window
  // limit. Postgres-side buckets likewise outlive any block.
  if (attempt.blockedUntil && now >= attempt.blockedUntil) {
    delete attempt.blockedUntil;
  }

  if (now - attempt.firstAttempt > config.windowMs) {
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
  inMemoryAttempts.delete(boundedIdentifier(identifier));
}

function inMemoryGetRateLimitStatus(
  identifier: string,
  config: RateLimitConfig
): { blocked: boolean; retryAfter?: number; attemptsRemaining?: number } {
  const now = Date.now();
  const attempt = inMemoryAttempts.get(boundedIdentifier(identifier));

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

// -----------------------------------------------------------------------------
// Postgres circuit breaker (production only)
// -----------------------------------------------------------------------------
// The outage this module defends against is an OOM-STALLED Postgres, not a
// fast-rejecting one: without a breaker, every request waits out the pool's
// connection/statement timeouts (seconds each) before falling back — adding
// user-facing latency and piling more work onto the struggling database.
// While the circuit is open, request paths skip Postgres entirely and use the
// conservative in-memory fallback; once the cooldown elapses, exactly ONE
// request claims the half-open probe (the claim is atomic — single-threaded
// event loop) and either closes the circuit or re-opens it. Concurrent
// requests during the probe stay on the fallback, so an expiring cooldown
// cannot stampede the stalled pool every 30 seconds.
const PG_PROBE_COOLDOWN_MS = 30_000;
let pgUnhealthyUntil = 0;
let pgProbeInFlight = false;
// Bumped every time the circuit opens. A success may only close the circuit
// if no open happened after that request was admitted — otherwise a slow
// success dispatched BEFORE the failure would clear the fresh cooldown and
// re-expose the unhealthy database to the full request stream.
let pgCircuitEpoch = 0;

/**
 * Gate for every request-path Postgres attempt. Returns true when the caller
 * may touch the database — either the circuit is closed, or the caller just
 * claimed the single half-open probe. A claimant MUST end its attempt in
 * closePgCircuit() (success) or openPgCircuit() (failure); both release the
 * claim.
 */
function pgGateAllowsDb(now: number): boolean {
  if (process.env.NODE_ENV !== 'production' || pgUnhealthyUntil === 0) {
    return true;
  }
  if (now < pgUnhealthyUntil || pgProbeInFlight) {
    return false;
  }
  pgProbeInFlight = true;
  return true;
}

function openPgCircuit(now: number): void {
  pgUnhealthyUntil = now + PG_PROBE_COOLDOWN_MS;
  pgProbeInFlight = false;
  pgCircuitEpoch++;
}

// Unconditional close — reserved for full state resets (shutdown).
function closePgCircuit(): void {
  pgUnhealthyUntil = 0;
  pgProbeInFlight = false;
}

/**
 * Close the circuit after a successful Postgres operation, but only if the
 * circuit has not been (re)opened since the caller was admitted — a stale
 * success from before a failure must not cancel the failure's cooldown.
 */
function closePgCircuitIfCurrent(admittedEpoch: number): void {
  if (admittedEpoch === pgCircuitEpoch) {
    closePgCircuit();
  }
}

/**
 * Distinguish "Postgres is unreachable/overloaded" from "Postgres actively
 * rejected this query". Only the former may open the process-wide circuit:
 * per-query errors can be attacker-crafted (an oversized identifier blowing
 * the index entry limit fails only that insert, with SQLSTATE 54000), and
 * treating them as outages would let a single hostile request degrade every
 * instance to the conservative fallback while the database is healthy.
 *
 * Rule, walking the drizzle wrapper's cause chain: an errno-style network
 * code (ECONNREFUSED, ETIMEDOUT, ...) is an outage. A 5-char SQLSTATE in
 * class 08 (connection), 53 (insufficient resources) or 57 (operator
 * intervention/shutdown) is an outage; any other SQLSTATE means the server
 * was alive enough to answer — not an outage. No code anywhere means no
 * server response (socket errors, generic timeouts) — treat as an outage,
 * since payload-triggerable failures always come back with a SQLSTATE.
 */
export function isPgUnavailabilityError(error: unknown): boolean {
  const OUTAGE_SQLSTATE_CLASSES = new Set(['08', '53', '57']);
  let sawServerSqlstate = false;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === 'string') {
      if (/^E[A-Z_]+$/.test(code)) {
        return true; // errno-style driver/network failure
      }
      if (/^[0-9A-Z]{5}$/.test(code)) {
        if (OUTAGE_SQLSTATE_CLASSES.has(code.slice(0, 2))) {
          return true;
        }
        sawServerSqlstate = true;
      }
    }
    // Error.cause is untyped under this package's typecheck lib target.
    current = (current as Error & { cause?: unknown }).cause;
  }
  return !sawServerSqlstate;
}

/**
 * Record a failed Postgres attempt from a request path: open the circuit for
 * genuine unavailability, otherwise just release any half-open probe claim so
 * a server-returned per-query error never trips the breaker.
 */
function recordPgFailure(error: unknown, now: number): void {
  if (isPgUnavailabilityError(error)) {
    openPgCircuit(now);
  } else {
    pgProbeInFlight = false;
  }
}

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
// During an outage every rate-limited request routes through the fallback;
// an unthrottled per-request WARN would flood logging during the very
// incident the breaker mitigates. One WARN per interval, carrying how many
// occurrences were suppressed since the last emit.
const FALLBACK_WARN_INTERVAL_MS = 30_000;
let lastFallbackWarnAt = 0;
let suppressedFallbackWarns = 0;

export function conservativeFallbackCheck(
  identifier: string,
  config: RateLimitConfig,
  memCheck: (identifier: string, config: RateLimitConfig) => RateLimitResult = inMemoryCheckRateLimit,
): RateLimitResult {
  const safeId = String(identifier ?? '').slice(0, 20);
  const logId = safeId.length >= 20 ? `${safeId}...` : safeId;

  try {
    const result = memCheck(identifier, conservativeFallbackConfig(config));
    const now = Date.now();
    if (lastFallbackWarnAt === 0 || now - lastFallbackWarnAt >= FALLBACK_WARN_INTERVAL_MS) {
      loggers.api.warn(
        'RATE_LIMIT_PG_FALLBACK: Postgres unavailable in production - enforcing conservative per-instance in-memory limit',
        {
          identifier: logId,
          allowed: result.allowed,
          suppressedSinceLastWarn: suppressedFallbackWarns,
        },
      );
      lastFallbackWarnAt = now;
      suppressedFallbackWarns = 0;
    } else {
      suppressedFallbackWarns++;
    }
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

  if (!pgGateAllowsDb(now)) {
    return conservativeFallbackCheck(identifier, config);
  }
  const admittedEpoch = pgCircuitEpoch;

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

    closePgCircuitIfCurrent(admittedEpoch);
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
      recordPgFailure(error, Date.now());
      return conservativeFallbackCheck(identifier, config);
    }

    return inMemoryCheckRateLimit(identifier, config);
  }
}

/**
 * Reset rate limit for an identifier (e.g., after successful auth).
 */
export async function resetDistributedRateLimit(identifier: string): Promise<void> {
  // Deliberately NOT gated by the circuit breaker: a reset REFUNDS a consumed
  // limit (e.g. EXPORT_DATA's single attempt per 24h after a failed export),
  // so silently skipping the delete while the circuit is open would leave the
  // Postgres row intact and 429 the caller for the rest of the window once
  // Postgres recovers. Resets are low-volume cold paths (post-auth-success,
  // failure refunds) that cannot stampede a stalled pool the way hot check
  // paths can; a failed delete keeps the pre-breaker best-effort semantics
  // and re-arms the breaker, while a success doubles as recovery evidence.
  const admittedEpoch = pgCircuitEpoch;
  try {
    await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.key, identifier));
    closePgCircuitIfCurrent(admittedEpoch);
  } catch (error) {
    loggers.api.debug('Postgres rate limit reset failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    recordPgFailure(error, Date.now());
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

  if (!pgGateAllowsDb(now)) {
    return conservativeFallbackStatus(identifier, config);
  }
  const admittedEpoch = pgCircuitEpoch;

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

    closePgCircuitIfCurrent(admittedEpoch);
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
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      recordPgFailure(error, Date.now());
      return conservativeFallbackStatus(identifier, config);
    }

    return inMemoryGetRateLimitStatus(identifier, config);
  }
}

/**
 * Read-only counterpart of conservativeFallbackCheck: reports the state of the
 * conservative in-memory bucket while Postgres is unreachable, failing closed
 * (blocked) only if the in-memory read itself throws.
 */
function conservativeFallbackStatus(
  identifier: string,
  config: RateLimitConfig,
): { blocked: boolean; retryAfter?: number; attemptsRemaining?: number } {
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

/**
 * Increment and return the authentication-failure count for an identifier in
 * the current window. Reuses the `rate_limit_buckets` table with an
 * `authfail:` key prefix so the count survives restarts and spans replicas
 * (#977) — feeding the pure auth-anomaly detector.
 *
 * Best-effort: returns 0 on DB error (and immediately while the Postgres
 * circuit is open), so the caller treats an unknown count as "no anomaly"
 * rather than failing — or stalling — the auth request.
 */
export async function countAuthFailure(identifier: string, windowMs: number): Promise<number> {
  const now = Date.now();

  if (!pgGateAllowsDb(now)) {
    return 0;
  }
  const admittedEpoch = pgCircuitEpoch;

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
    closePgCircuitIfCurrent(admittedEpoch);
    return rows[0]?.count ?? 0;
  } catch (error) {
    loggers.api.warn('countAuthFailure failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    recordPgFailure(error, Date.now());
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
  // Notification email dispatched per form submission: keyed by formTargetId
  // (not IP/token — see the route), so it bounds the total mail volume a
  // recipient can be sent regardless of how many distinct submitters trigger
  // it. FORM_SUBMISSION already caps how fast one submitter can hit a given
  // token (10/min), but a script rotating IPs against the same public token
  // could otherwise still ride that limit indefinitely and mail-bomb the
  // owner's inbox once per accepted submission, since sendEmail's own
  // recipient-wide 3/hr cap is intentionally skipped for this dispatch (see
  // send-form-notification.ts).
  FORM_SUBMISSION_NOTIFICATION: {
    maxAttempts: 20,
    windowMs: 60 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000,
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
  // Per-WEBHOOK budget on DETERMINISTIC workflow runs (key:
  // `page-webhook-deterministic-budget:{webhookId}`). All-tool-step chains
  // never invoke a model, so the AI budget's 60/hr would be needlessly
  // tight — but a leaked secret still forces page writes / channel posts /
  // task mutations through the bound triggers, so aggregate runs stay
  // bounded per webhook, just at a cheaper ceiling. Channel-posting steps
  // additionally draw from the shared 30/min PAGE_WEBHOOK bucket.
  PAGE_WEBHOOK_DETERMINISTIC_BUDGET: {
    maxAttempts: 300,
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
