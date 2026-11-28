/**
 * Agent lifecycle sweep (ADR 0008 Decision 13, [D-30] decided = 30 days;
 * Agent Signup Phase 5 leaf 3) — the adapter the `agent-lifecycle` cron runs.
 *
 * Three jobs, in order, each independent of the others' failure:
 *   1. delete expired `agent_signup_challenges` (single-use, 5-minute TTL);
 *   2. delete expired `agent_claims` (an expired claim can never settle:
 *      `decideClaimPoll` checks expiry before settlement);
 *   3. erase every unclaimed agent that never authenticated after signup and
 *      is at least 30 days old — the frozen `decideAgentLifecycle` is the ONLY
 *      judge. The candidate query merely narrows the scan; every candidate is
 *      decided, and decided AGAIN against a fresh read immediately before
 *      erasing, so an agent that signs in mid-sweep is kept.
 *
 * Erasure is injected: the caller (the web cron) routes it through the
 * platform's GDPR account-erasure path (a data-subject-request row, then the
 * processor's durable erasure job), never a raw delete — the same cascade a
 * person deleting their own account gets.
 *
 * @module @pagespace/lib/services/agent-lifecycle
 */

import { db } from '@pagespace/db/db';
import { and, asc, eq, gt, isNull, lt, lte, or } from '@pagespace/db/operators';
import { agentClaims, agentIdentities, agentSignupChallenges } from '@pagespace/db/schema/agent-identities';
import {
  AGENT_UNAUTHENTICATED_TTL_MS,
  decideAgentLifecycle,
  type AgentLifecycleRow,
} from '../auth/agent/lifecycle-decision';
import { loggers } from '../logging/logger-config';
import { redactDbError } from '../logging/db-error-redaction';

/** Candidates fetched per query; the sweep pages batch after batch (security review addendum). */
export const AGENT_LIFECYCLE_BATCH_LIMIT = 50;

/**
 * At most this many agents are erased per run; the rest wait for the next
 * (hourly) tick. Bounds the processor queue while still outrunning the signup
 * budget: 500 an hour against at most `AGENT_SIGNUP_GLOBAL_BUDGET` (100) new
 * agents an hour, so a backlog always drains.
 */
export const AGENT_LIFECYCLE_MAX_ERASURES_PER_RUN = 500;

/** A run stops paging after this long, finishing the agent in hand. Well under the cron's HTTP timeout. */
export const AGENT_LIFECYCLE_TIME_BUDGET_MS = 5 * 60 * 1000;

export interface AgentLifecycleCandidate extends AgentLifecycleRow {
  userId: string;
}

export interface AgentLifecycleCursor {
  createdAt: Date;
  userId: string;
}

export interface AgentLifecycleStore {
  pruneExpiredChallenges(now: Date): Promise<number>;
  pruneExpiredClaims(now: Date): Promise<number>;
  /**
   * One page of candidates in `(createdAt, userId)` order, strictly after the
   * `after` cursor (`null`: from the start). Keyset paging, so an agent kept or
   * failed in one batch is never fetched again in the same run.
   */
  findCandidates(input: { createdAtOrBefore: Date; limit: number; after: AgentLifecycleCursor | null }): Promise<AgentLifecycleCandidate[]>;
  /** A fresh read of one agent's lifecycle facts; `null` once it is gone. */
  getLifecycleRow(userId: string): Promise<AgentLifecycleCandidate | null>;
}

/**
 * Store failures are logged redacted (a query error's message carries its bound
 * params) and rethrown as a constant-message error the sweep can report.
 */
async function guard<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    loggers.system.error('Agent lifecycle store failed', { operation, ...redactDbError(error) });
    throw new Error(`agent lifecycle store failed: ${operation}`);
  }
}

const lifecycleColumns = {
  userId: agentIdentities.userId,
  ownerUserId: agentIdentities.ownerUserId,
  lastAuthAt: agentIdentities.lastAuthAt,
  createdAt: agentIdentities.createdAt,
};

/**
 * How long an EXPIRED claim row is kept before the prune deletes it. While it exists, an agent
 * polling the claim grant with that claim token is told `expired_token` (start a new claim)
 * instead of the `invalid_grant` an unknown token gets. A day covers an agent that polls late.
 */
export const CLAIM_EXPIRED_GRACE_MS = 24 * 60 * 60 * 1000;

export const agentLifecycleStore: AgentLifecycleStore = {
  async pruneExpiredChallenges(now) {
    const deleted = await guard('prune_challenges', () =>
      db.delete(agentSignupChallenges).where(lt(agentSignupChallenges.expiresAt, now)).returning({ id: agentSignupChallenges.id }),
    );
    return deleted.length;
  },

  async pruneExpiredClaims(now) {
    const deleted = await guard('prune_claims', () =>
      db.delete(agentClaims).where(lt(agentClaims.expiresAt, new Date(now.getTime() - CLAIM_EXPIRED_GRACE_MS))).returning({ id: agentClaims.id }),
    );
    return deleted.length;
  },

  async findCandidates({ createdAtOrBefore, limit, after }) {
    return guard('find_candidates', () =>
      db
        .select(lifecycleColumns)
        .from(agentIdentities)
        .where(
          and(
            isNull(agentIdentities.ownerUserId),
            isNull(agentIdentities.lastAuthAt),
            lte(agentIdentities.createdAt, createdAtOrBefore),
            after === null
              ? undefined
              : or(
                  gt(agentIdentities.createdAt, after.createdAt),
                  and(eq(agentIdentities.createdAt, after.createdAt), gt(agentIdentities.userId, after.userId)),
                ),
          ),
        )
        .orderBy(asc(agentIdentities.createdAt), asc(agentIdentities.userId))
        .limit(limit),
    );
  },

  async getLifecycleRow(userId) {
    const [row] = await guard('get_lifecycle_row', () =>
      db.select(lifecycleColumns).from(agentIdentities).where(eq(agentIdentities.userId, userId)).limit(1),
    );
    return row ?? null;
  },
};

export interface AgentLifecycleSweepResult {
  /** `null` when that prune failed (see `failures`). */
  challengesPruned: number | null;
  claimsPruned: number | null;
  candidates: number;
  erased: number;
  kept: number;
  failed: number;
  /** Candidate pages fetched this run. */
  batches: number;
  /** Why the run ended: the backlog ran out, or a per-run budget did (the next tick resumes). */
  stoppedBy: 'drained' | 'erasure_budget' | 'time_budget';
  /** `userId: null` for a prune failure. Messages are constant-shape — never a bound value. */
  failures: Array<{ userId: string | null; error: string }>;
}

export interface SweepAgentLifecycleInput {
  now: Date;
  /** Routes one agent through the account-erasure path. Throwing marks only that agent failed. */
  eraseAgent: (userId: string) => Promise<void>;
  store?: AgentLifecycleStore;
  /** Batch size; defaults to `AGENT_LIFECYCLE_BATCH_LIMIT`. */
  limit?: number;
  /** Defaults to `AGENT_LIFECYCLE_MAX_ERASURES_PER_RUN`. */
  maxErasures?: number;
  /** Defaults to `AGENT_LIFECYCLE_TIME_BUDGET_MS`. */
  timeBudgetMs?: number;
  /** Milliseconds since the run started; injected for tests, defaults to a wall clock. */
  elapsedMs?: () => number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function sweepAgentLifecycle(input: SweepAgentLifecycleInput): Promise<AgentLifecycleSweepResult> {
  const store = input.store ?? agentLifecycleStore;
  const failures: AgentLifecycleSweepResult['failures'] = [];

  const prune = async (label: string, run: () => Promise<number>): Promise<number | null> => {
    try {
      return await run();
    } catch (error) {
      failures.push({ userId: null, error: `${label}: ${messageOf(error)}` });
      return null;
    }
  };
  const challengesPruned = await prune('prune challenges', () => store.pruneExpiredChallenges(input.now));
  const claimsPruned = await prune('prune claims', () => store.pruneExpiredClaims(input.now));

  const batchSize = input.limit ?? AGENT_LIFECYCLE_BATCH_LIMIT;
  const maxErasures = input.maxErasures ?? AGENT_LIFECYCLE_MAX_ERASURES_PER_RUN;
  const timeBudgetMs = input.timeBudgetMs ?? AGENT_LIFECYCLE_TIME_BUDGET_MS;
  const startedAt = Date.now();
  const elapsedMs = input.elapsedMs ?? (() => Date.now() - startedAt);
  const createdAtOrBefore = new Date(input.now.getTime() - AGENT_UNAUTHENTICATED_TTL_MS);

  let candidates = 0;
  let erased = 0;
  let kept = 0;
  let failed = 0;
  let batches = 0;
  let after: AgentLifecycleCursor | null = null;
  let stoppedBy: AgentLifecycleSweepResult['stoppedBy'] = 'drained';

  const budgetSpent = (): AgentLifecycleSweepResult['stoppedBy'] | null => {
    if (erased >= maxErasures) return 'erasure_budget';
    if (elapsedMs() >= timeBudgetMs) return 'time_budget';
    return null;
  };

  sweep: for (;;) {
    let batch: AgentLifecycleCandidate[];
    try {
      batch = await store.findCandidates({ createdAtOrBefore, limit: batchSize, after });
    } catch (error) {
      failures.push({ userId: null, error: `find candidates: ${messageOf(error)}` });
      break;
    }
    batches += 1;
    candidates += batch.length;

    for (const candidate of batch) {
      const spent = budgetSpent();
      if (spent !== null) {
        stoppedBy = spent;
        break sweep;
      }
      if (decideAgentLifecycle(candidate, input.now).action !== 'delete') {
        kept += 1;
        continue;
      }
      try {
        // The candidate list is a snapshot; the decision that authorizes an
        // irreversible erasure is taken on the row as it is now.
        const fresh = await store.getLifecycleRow(candidate.userId);
        if (fresh === null || decideAgentLifecycle(fresh, input.now).action !== 'delete') {
          kept += 1;
          continue;
        }
        await input.eraseAgent(candidate.userId);
        erased += 1;
      } catch (error) {
        failed += 1;
        failures.push({ userId: candidate.userId, error: messageOf(error) });
      }
    }

    const last = batch[batch.length - 1];
    if (batch.length < batchSize || last === undefined) break;
    // Page past this batch, kept and failed rows included: none is fetched twice in one run.
    after = { createdAt: last.createdAt, userId: last.userId };
    const spent = budgetSpent();
    if (spent !== null) {
      stoppedBy = spent;
      break;
    }
  }

  return { challengesPruned, claimsPruned, candidates, erased, kept, failed, batches, stoppedBy, failures };
}
