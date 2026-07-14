import { getAdvisoryLockPool } from '@pagespace/db/db';
import { withAdvisoryLock, type AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import { loggers, logPerformance } from '@pagespace/lib/logging/logger-config';

/**
 * Per-conversation in-flight guard, closed (best-effort) via a Postgres session-level
 * advisory lock. See route.ts:1193-1211 (POST /api/ai/chat) for the check-then-act race this
 * replaces: `takeOverConversationStreams`'s SELECT and `createStreamLifecycle`'s INSERT were not
 * atomic together, so two near-simultaneous sends could both see zero in-flight rows and both
 * proceed — two generations, two bills.
 *
 * NOT an invariant. On `lock_busy` — the lock already held by a concurrent send on the SAME
 * conversation — this retries `MAX_LOCK_BUSY_RETRIES` times at `LOCK_BUSY_RETRY_DELAY_MS`
 * apart, then gives up and runs `fn` UNLOCKED: availability wins over serialization, a send must
 * never block on this. That degraded path is today's (pre-this-PR) behavior exactly — a
 * concurrent double-generate stays possible, just narrowed to the rare pool-exhaustion/contention
 * case instead of every concurrent send. See the PR 4 board page for the full guarantee, named
 * honestly as best-effort (epic rail 12).
 *
 * A SECOND, distinct degrade path: if the lock connection itself is broken — `pool.connect()`
 * or the try-lock query throws, e.g. the dedicated advisory-lock pool (`getAdvisoryLockPool`,
 * `max: 10`) is exhausted or a connection resets — that is degraded to unlocked immediately, with
 * no retry. It is not `lock_busy` (nothing resolved false; nothing is contending for the lock)
 * and retrying a broken connection on a 300ms cadence would only add latency to a send that must
 * never block. Both degrade paths emit the same telemetry, tagged with a `reason` so they stay
 * distinguishable (`lock_busy` vs `lock_error`) in logs/metrics.
 *
 * `fn` (takeover + lifecycle-create today; the assistant message-row insert once PR 2 lands —
 * see the seam note on the PR 2 page) runs exactly once per call, either inside the lock or,
 * on degrade, once unlocked. It never runs twice for one `startGenerationExclusive` call.
 */

export const MAX_LOCK_BUSY_RETRIES = 3;
export const LOCK_BUSY_RETRY_DELAY_MS = 300;

function advisoryLockKeyFor(conversationId: string): string {
  return `ai-send:${conversationId}`;
}

export type LockBusyDecision = { action: 'retry'; delayMs: number } | { action: 'proceed_unlocked' };

/**
 * Pure decision: given how many `lock_busy` outcomes have been seen so far for this call,
 * should it retry (and how long to wait), or give up and proceed unlocked? No I/O, no clock —
 * every branch is exhaustively testable by attemptsMade alone.
 */
export function decideOnLockBusy({ attemptsMade }: { attemptsMade: number }): LockBusyDecision {
  return attemptsMade <= MAX_LOCK_BUSY_RETRIES
    ? { action: 'retry', delayMs: LOCK_BUSY_RETRY_DELAY_MS }
    : { action: 'proceed_unlocked' };
}

export type StartGenerationExclusiveOutcome<T> =
  | { outcome: 'locked'; result: T }
  | { outcome: 'degraded'; result: T };

export interface StartGenerationExclusiveParams<T> {
  conversationId: string;
  /**
   * The critical section: takeover + lifecycle-create today. Runs exactly once, either inside
   * the advisory lock or (degraded) unlocked — never both, never twice.
   */
  run: () => Promise<T>;
  /** Defaults to the dedicated advisory-lock pool (db.ts:36-55). Overridable for tests. */
  pool?: AdvisoryLockPool;
  /** Overridable for tests; defaults to a real timer-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Why this call degraded to running `run` unlocked, for the shared telemetry below. */
type DegradeReason =
  /** The retry budget was exhausted on a resolved `lock_busy` (another send holds the lock). */
  | 'lock_busy'
  /**
   * The lock machinery itself failed — `pool.connect()` or the try-lock query threw (pool
   * exhaustion, connection reset), never resolving to `acquired`/`lock_busy` at all. Distinct
   * from `lock_busy`: nothing is contending for the lock, the lock connection is just broken.
   */
  | 'lock_error';

function degradeToUnlocked(info: {
  conversationId: string;
  attemptsMade: number;
  reason: DegradeReason;
  /** Set only for `reason: 'lock_error'` — the error the lock connection itself threw. */
  error?: unknown;
}): void {
  const { error, ...metricInfo } = info;
  // Rail 8: never silent. Named metric + structured warn, always — best-effort serialization
  // gives up here; availability wins over serialization, a send must never block on this lock.
  logPerformance('ai_send.advisory_lock_degraded', 1, 'count', metricInfo);
  loggers.ai.warn(
    'start-generation-exclusive: advisory lock unavailable, proceeding unlocked (degraded, best-effort serialization)',
    { ...metricInfo, ...(error !== undefined ? { error: error instanceof Error ? error.message : String(error) } : {}) },
  );
}

export async function startGenerationExclusive<T>(
  params: StartGenerationExclusiveParams<T>,
): Promise<StartGenerationExclusiveOutcome<T>> {
  const { conversationId, run } = params;
  const pool = params.pool ?? getAdvisoryLockPool();
  const sleep = params.sleep ?? defaultSleep;
  const lockKey = advisoryLockKeyFor(conversationId);

  let attemptsMade = 0;
  for (;;) {
    let attempt;
    try {
      attempt = await withAdvisoryLock(pool, lockKey, run);
    } catch (error) {
      // The lock connection itself failed (pool.connect() or the try-lock query threw) —
      // NOT `run` throwing. `run` (takeover + lifecycle-create) is documented to catch and
      // log its own errors and never throw, so this catch can only be reached by the lock
      // machinery; `run` has not been invoked yet on this path. Degrade immediately rather
      // than retry: a broken connection is not "busy" and won't resolve itself in 300ms the
      // way lock contention might, so retrying here would only add latency to a send that
      // must never block. See the PR board page's verification: "Lock-pool exhaustion
      // simulation: proceeds unlocked, metric emitted, warn logged, both requests complete."
      degradeToUnlocked({ conversationId, attemptsMade, reason: 'lock_error', error });
      const result = await run();
      return { outcome: 'degraded', result };
    }

    if (attempt.outcome === 'acquired') {
      return { outcome: 'locked', result: attempt.result };
    }

    attemptsMade += 1;
    const decision = decideOnLockBusy({ attemptsMade });
    if (decision.action === 'retry') {
      await sleep(decision.delayMs);
      continue;
    }

    degradeToUnlocked({ conversationId, attemptsMade, reason: 'lock_busy' });
    const result = await run();
    return { outcome: 'degraded', result };
  }
}
