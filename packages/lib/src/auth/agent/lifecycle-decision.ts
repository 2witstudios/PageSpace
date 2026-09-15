/**
 * Agent lifecycle (ADR 0005 Decision 13, [D-28]): an unclaimed agent that
 * never authenticated after signup is an abandoned signup, not an entity —
 * delete it after 30 days. An agent that ever signed in, or that has an
 * owner, is kept with no TTL. The cron (Phase 5) fetches candidate rows and
 * calls this per row; the clock is injected.
 *
 * @module @pagespace/lib/auth/agent/lifecycle-decision
 */

export const AGENT_UNAUTHENTICATED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AgentLifecycleRow {
  ownerUserId: string | null;
  /** Last successful sign-in or assertion exchange; null if the agent never authenticated. */
  lastAuthAt: Date | null;
  createdAt: Date;
}

export type AgentLifecycleDecision = { action: 'keep' } | { action: 'delete' };

export function decideAgentLifecycle(row: AgentLifecycleRow, now: Date): AgentLifecycleDecision {
  if (row.ownerUserId !== null) return { action: 'keep' };
  if (row.lastAuthAt !== null) return { action: 'keep' };
  if (now.getTime() - row.createdAt.getTime() >= AGENT_UNAUTHENTICATED_TTL_MS) {
    return { action: 'delete' };
  }
  return { action: 'keep' };
}
