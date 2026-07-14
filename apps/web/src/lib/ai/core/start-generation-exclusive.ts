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

export async function startGenerationExclusive<T>(
  params: StartGenerationExclusiveParams<T>,
): Promise<StartGenerationExclusiveOutcome<T>> {
  const { conversationId, run } = params;
  const pool = params.pool ?? getAdvisoryLockPool();
  const sleep = params.sleep ?? defaultSleep;
  const lockKey = advisoryLockKeyFor(conversationId);

  let attemptsMade = 0;
  for (;;) {
    const attempt = await withAdvisoryLock(pool, lockKey, run);
    if (attempt.outcome === 'acquired') {
      return { outcome: 'locked', result: attempt.result };
    }

    attemptsMade += 1;
    const decision = decideOnLockBusy({ attemptsMade });
    if (decision.action === 'retry') {
      await sleep(decision.delayMs);
      continue;
    }

    // Degraded path (rail 8: never silent). Best-effort serialization gives up here —
    // availability wins over serialization, a send must never block on this lock.
    logPerformance('ai_send.advisory_lock_degraded', 1, 'count', { conversationId, attemptsMade });
    loggers.ai.warn(
      'start-generation-exclusive: advisory lock busy after retries, proceeding unlocked (degraded, best-effort serialization)',
      { conversationId, attemptsMade },
    );

    const result = await run();
    return { outcome: 'degraded', result };
  }
}
