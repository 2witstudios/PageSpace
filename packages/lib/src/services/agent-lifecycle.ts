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
import { and, asc, eq, isNull, lt, lte } from '@pagespace/db/operators';
import { agentClaims, agentIdentities, agentSignupChallenges } from '@pagespace/db/schema/agent-identities';
import {
  AGENT_UNAUTHENTICATED_TTL_MS,
  decideAgentLifecycle,
  type AgentLifecycleRow,
} from '../auth/agent/lifecycle-decision';
import { loggers } from '../logging/logger-config';
import { redactDbError } from '../logging/db-error-redaction';

/** At most this many agents are erased per run; the rest wait for the next tick. Bounds the processor queue. */
export const AGENT_LIFECYCLE_BATCH_LIMIT = 50;

export interface AgentLifecycleCandidate extends AgentLifecycleRow {
  userId: string;
}

export interface AgentLifecycleStore {
  pruneExpiredChallenges(now: Date): Promise<number>;
  pruneExpiredClaims(now: Date): Promise<number>;
  findCandidates(input: { createdAtOrBefore: Date; limit: number }): Promise<AgentLifecycleCandidate[]>;
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

export const agentLifecycleStore: AgentLifecycleStore = {
  async pruneExpiredChallenges(now) {
    const deleted = await guard('prune_challenges', () =>
      db.delete(agentSignupChallenges).where(lt(agentSignupChallenges.expiresAt, now)).returning({ id: agentSignupChallenges.id }),
    );
    return deleted.length;
  },

  async pruneExpiredClaims(now) {
    const deleted = await guard('prune_claims', () =>
      db.delete(agentClaims).where(lt(agentClaims.expiresAt, now)).returning({ id: agentClaims.id }),
    );
    return deleted.length;
  },

  async findCandidates({ createdAtOrBefore, limit }) {
    return guard('find_candidates', () =>
      db
        .select(lifecycleColumns)
        .from(agentIdentities)
        .where(
          and(
            isNull(agentIdentities.ownerUserId),
            isNull(agentIdentities.lastAuthAt),
            lte(agentIdentities.createdAt, createdAtOrBefore),
          ),
        )
        .orderBy(asc(agentIdentities.createdAt))
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
  /** `userId: null` for a prune failure. Messages are constant-shape — never a bound value. */
  failures: Array<{ userId: string | null; error: string }>;
}

export interface SweepAgentLifecycleInput {
  now: Date;
  /** Routes one agent through the account-erasure path. Throwing marks only that agent failed. */
  eraseAgent: (userId: string) => Promise<void>;
  store?: AgentLifecycleStore;
  limit?: number;
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

  let candidates: AgentLifecycleCandidate[] = [];
  try {
    candidates = await store.findCandidates({
      createdAtOrBefore: new Date(input.now.getTime() - AGENT_UNAUTHENTICATED_TTL_MS),
      limit: input.limit ?? AGENT_LIFECYCLE_BATCH_LIMIT,
    });
  } catch (error) {
    failures.push({ userId: null, error: `find candidates: ${messageOf(error)}` });
  }

  let erased = 0;
  let kept = 0;
  let failed = 0;
  for (const candidate of candidates) {
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

  return { challengesPruned, claimsPruned, candidates: candidates.length, erased, kept, failed, failures };
}
