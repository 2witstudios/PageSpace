/**
 * Per-user daily AI-usage rate-limit cache.
 *
 * Stores counters in the shared `rate_limit_buckets (key, window_start)` table
 * using a key scheme of `ai-usage:{userId}:{providerType}`. The window_start is
 * today-midnight-UTC; a new day is a new `(key, window_start)` pair, so the
 * daily reset happens by construction. `expires_at` is tomorrow-midnight-UTC,
 * picked up later by `sweepExpiredRateLimitBuckets`.
 *
 * Atomicity comes from a single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
 * round-trip; concurrent writers serialize on the row lock.
 *
 * The DB is the source of truth. In non-production environments an L1
 * in-process cache mirrors DB writes so that, when the DB is unreachable,
 * callers can fall back to last-known counts and keep local workflows
 * responsive. In production the L1 cache is never written or read — reads
 * and writes all round-trip to Postgres.
 *
 * Fail-closed contract: in production with the DB unavailable, callers
 * receive a blocked `UsageTrackingResult`.
 */

import { db, rateLimitBuckets, sql, eq, and } from '@pagespace/db';
import { loggers } from '../logging/logger-config';

export type ProviderType = 'standard' | 'pro';

export interface UsageTrackingResult {
  success: boolean;
  currentCount: number;
  limit: number;
  remainingCalls: number;
}

interface RateLimitConfig {
  keyPrefix: string;
}

interface MemoryEntry {
  count: number;
  windowStartMs: number;
  expiresAtMs: number;
}

const todayMidnightUTC = (now: Date = new Date()): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));

const tomorrowMidnightUTC = (now: Date = new Date()): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));

const blockedResult = (limit: number, currentCount: number = limit): UsageTrackingResult => ({
  success: false,
  currentCount,
  limit,
  remainingCalls: 0,
});

const maskUserId = (userId: string): string =>
  userId.length <= 8 ? userId : `${userId.slice(0, 4)}...${userId.slice(-4)}`;

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

export class RateLimitCache {
  private static instance: RateLimitCache | null = null;

  private memoryCache = new Map<string, MemoryEntry>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private config: RateLimitConfig;

  private constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = {
      keyPrefix: 'ai-usage:',
      ...config,
    };
    this.startMemoryCacheCleanup();
  }

  static getInstance(config?: Partial<RateLimitConfig>): RateLimitCache {
    if (!RateLimitCache.instance) {
      RateLimitCache.instance = new RateLimitCache(config);
    }
    return RateLimitCache.instance;
  }

  private startMemoryCacheCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      let cleanedCount = 0;
      for (const [key, entry] of this.memoryCache.entries()) {
        if (now >= entry.expiresAtMs) {
          this.memoryCache.delete(key);
          cleanedCount++;
        }
      }
      if (cleanedCount > 0) {
        loggers.api.debug(`Cleaned ${cleanedCount} expired rate limit cache entries`);
      }
    }, 60_000);
  }

  private getRateLimitKey(userId: string, providerType: ProviderType): string {
    return `${this.config.keyPrefix}${userId}:${providerType}`;
  }

  private readMemory(key: string, windowStartMs: number): MemoryEntry | null {
    const entry = this.memoryCache.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (now >= entry.expiresAtMs || entry.windowStartMs !== windowStartMs) {
      this.memoryCache.delete(key);
      return null;
    }
    return entry;
  }

  private writeMemory(key: string, count: number, windowStart: Date, expiresAt: Date): void {
    if (isProduction()) return;
    this.memoryCache.set(key, {
      count,
      windowStartMs: windowStart.getTime(),
      expiresAtMs: expiresAt.getTime(),
    });
  }

  private incrementMemoryFallback(
    key: string,
    limit: number,
    windowStart: Date,
    expiresAt: Date,
  ): UsageTrackingResult {
    const current = this.readMemory(key, windowStart.getTime())?.count ?? 0;
    if (current >= limit) return blockedResult(limit, current);

    const newCount = current + 1;
    this.writeMemory(key, newCount, windowStart, expiresAt);
    return {
      success: true,
      currentCount: newCount,
      limit,
      remainingCalls: limit - newCount,
    };
  }

  private logDbFailure(
    operation: string,
    userId: string,
    providerType: ProviderType,
    error: unknown,
  ): void {
    const err = error instanceof Error ? error : new Error(String(error));
    const metadata = {
      userId: maskUserId(userId),
      providerType,
      error: err.message,
    };

    if (isProduction()) {
      loggers.api.error(
        `Rate-limit ${operation} failed in production - failing closed`,
        err,
        metadata,
      );
      return;
    }
    loggers.api.warn(`Rate-limit ${operation} failed`, metadata);
  }

  async incrementUsage(
    userId: string,
    providerType: ProviderType,
    limit: number,
  ): Promise<UsageTrackingResult> {
    if (limit <= 0) return blockedResult(limit, 0);

    const key = this.getRateLimitKey(userId, providerType);
    const now = new Date();
    const windowStart = todayMidnightUTC(now);
    const expiresAt = tomorrowMidnightUTC(now);

    try {
      const rows = await db
        .insert(rateLimitBuckets)
        .values({ key, windowStart, count: 1, expiresAt })
        .onConflictDoUpdate({
          target: [rateLimitBuckets.key, rateLimitBuckets.windowStart],
          set: { count: sql`${rateLimitBuckets.count} + 1` },
        })
        .returning({ count: rateLimitBuckets.count });

      const newCount = rows[0]?.count ?? 1;

      if (newCount > limit) {
        await db
          .update(rateLimitBuckets)
          .set({ count: sql`${rateLimitBuckets.count} - 1` })
          .where(
            and(
              eq(rateLimitBuckets.key, key),
              eq(rateLimitBuckets.windowStart, windowStart),
            ),
          );
        this.writeMemory(key, limit, windowStart, expiresAt);
        return blockedResult(limit);
      }

      this.writeMemory(key, newCount, windowStart, expiresAt);
      return {
        success: true,
        currentCount: newCount,
        limit,
        remainingCalls: limit - newCount,
      };
    } catch (error) {
      this.logDbFailure('increment', userId, providerType, error);
      if (isProduction()) return blockedResult(limit);
      return this.incrementMemoryFallback(key, limit, windowStart, expiresAt);
    }
  }

  async getCurrentUsage(
    userId: string,
    providerType: ProviderType,
    limit: number,
  ): Promise<UsageTrackingResult> {
    const key = this.getRateLimitKey(userId, providerType);
    const now = new Date();
    const windowStart = todayMidnightUTC(now);
    const expiresAt = tomorrowMidnightUTC(now);

    try {
      const rows = await db
        .select({ count: rateLimitBuckets.count })
        .from(rateLimitBuckets)
        .where(
          and(
            eq(rateLimitBuckets.key, key),
            eq(rateLimitBuckets.windowStart, windowStart),
          ),
        )
        .limit(1);

      const count = rows[0]?.count ?? 0;
      if (count > 0) this.writeMemory(key, count, windowStart, expiresAt);

      return {
        success: count < limit,
        currentCount: count,
        limit,
        remainingCalls: Math.max(0, limit - count),
      };
    } catch (error) {
      this.logDbFailure('get', userId, providerType, error);
      if (isProduction()) return blockedResult(limit, limit);

      const entry = this.readMemory(key, windowStart.getTime());
      const count = entry?.count ?? 0;
      return {
        success: count < limit,
        currentCount: count,
        limit,
        remainingCalls: Math.max(0, limit - count),
      };
    }
  }

  async resetUsage(userId: string, providerType: ProviderType): Promise<void> {
    const key = this.getRateLimitKey(userId, providerType);
    this.memoryCache.delete(key);

    try {
      await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.key, key));
    } catch (error) {
      this.logDbFailure('reset', userId, providerType, error);
    }

    loggers.api.debug('Reset rate limit for user', {
      userId: maskUserId(userId),
      providerType,
    });
  }

  getCacheStats(): {
    memoryEntries: number;
    dbConfigured: boolean;
  } {
    return {
      memoryEntries: this.memoryCache.size,
      dbConfigured: !!process.env.DATABASE_URL,
    };
  }

  async clearAll(): Promise<void> {
    this.memoryCache.clear();
    try {
      await db
        .delete(rateLimitBuckets)
        .where(sql`${rateLimitBuckets.key} LIKE ${this.config.keyPrefix + '%'}`);
    } catch (error) {
      loggers.api.warn('Rate-limit clearAll failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    loggers.api.info('Cleared all rate limit cache entries');
  }

  async shutdown(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.memoryCache.clear();
    RateLimitCache.instance = null;
  }
}

export const rateLimitCache = RateLimitCache.getInstance();
