/**
 * The owner's side of agent identities — Settings → Agents (ADR 0008
 * Decisions 8, 14; Agent Signup Phase 4).
 *
 * Who may act is decided by the caller (the route asks the frozen
 * `agentSecretActor`, the same rule secret rotation uses); every write here is
 * ALSO scoped to `ownerUserId` in its WHERE, so a caller that skipped the check
 * still changes nothing it does not own. Revoking is the existing `revokeAgent`
 * (agent-identities.ts) — it already kills every live token and key.
 *
 * @module @pagespace/lib/services/agent-ownership
 */

import { db } from '@pagespace/db/db';
import { and, desc, eq, isNull, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { agentClaims, agentIdentities } from '@pagespace/db/schema/agent-identities';
import { oauthAccessTokens } from '@pagespace/db/schema/oauth';
import { decryptUserRows } from '../auth/user-repository';
import { AgentIdentityStoreError } from './agent-identities';
import { loggers } from '../logging/logger-config';
import { redactDbError } from '../logging/db-error-redaction';

/**
 * Any query error leaves as the identity store's redacted error: drizzle's
 * error message is the query plus its params, so the original must never
 * reach a route or a log.
 */
async function guardStore<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const redacted = redactDbError(error);
    loggers.auth.error('Agent ownership store failed', { operation, ...redacted });
    throw new AgentIdentityStoreError(operation, redacted);
  }
}

export interface OwnedAgent {
  agentUserId: string;
  name: string;
  /** Self-reported client label ("claude-code", …). Display only. */
  source: string | null;
  createdAt: Date;
  claimedAt: Date | null;
  /**
   * The latest of its last secret exchange and its newest access token — an
   * access token is minted on every refresh, so this tracks real use, not just
   * sign-ins. Null when it never authenticated.
   */
  lastActiveAt: Date | null;
  revokedAt: Date | null;
}

/** Every agent `ownerUserId` owns, newest claim first. */
export async function listOwnedAgents(ownerUserId: string): Promise<OwnedAgent[]> {
  // Correlated per agent row, so it reads only that agent's tokens (oauth_access_tokens_user_id_idx).
  const latestTokenAt = sql<Date | null>`(select max(${oauthAccessTokens.createdAt}) from ${oauthAccessTokens} where ${oauthAccessTokens.userId} = ${agentIdentities.userId})`
    .mapWith(agentIdentities.lastAuthAt);

  const rows = await guardStore('list_owned_agents', () => db
    .select({
      agentUserId: agentIdentities.userId,
      name: users.name,
      source: agentIdentities.source,
      createdAt: agentIdentities.createdAt,
      claimedAt: agentIdentities.claimedAt,
      lastAuthAt: agentIdentities.lastAuthAt,
      latestTokenAt,
      revokedAt: agentIdentities.revokedAt,
    })
    .from(agentIdentities)
    .innerJoin(users, eq(users.id, agentIdentities.userId))
    .where(eq(agentIdentities.ownerUserId, ownerUserId))
    .orderBy(desc(agentIdentities.claimedAt), desc(agentIdentities.createdAt)));

  const decrypted = await decryptUserRows(rows);
  return decrypted.map((row) => ({
    agentUserId: row.agentUserId,
    name: row.name,
    source: row.source,
    createdAt: row.createdAt,
    claimedAt: row.claimedAt,
    lastActiveAt: latestOf(row.lastAuthAt, row.latestTokenAt),
    revokedAt: row.revokedAt,
  }));
}

function latestOf(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

export type UnlinkAgentResult = { ok: true } | { ok: false };

/**
 * Release an agent the caller owns. It returns to the unclaimed state in one
 * transaction: no owner (so its AI spend no longer reaches the former owner —
 * resolveOwnCreditsPayer reads this row), `emailVerified` cleared (D-31: an
 * unclaimed agent cannot initiate DMs, invites or uploads), and every claim
 * of the agent's that is still open DENIED, so no user code handed out
 * earlier can be approved later. Its identity, drives, keys and tokens are
 * untouched — the agent stays itself, and starts a new claim with its own
 * credential if it wants an owner again.
 *
 * Nothing secret is returned (security review addendum to ADR 0008): the
 * former owner leaves holding nothing that can start, poll or approve a claim
 * for this agent. Not the owner (or no such agent) → `{ ok: false }`.
 */
export async function unlinkAgent(input: { ownerUserId: string; agentUserId: string; now: Date }): Promise<UnlinkAgentResult> {
  return guardStore('unlink_agent', () => db.transaction(async (tx) => {
    const released = await tx
      .update(agentIdentities)
      .set({ ownerUserId: null, claimedAt: null })
      .where(and(eq(agentIdentities.userId, input.agentUserId), eq(agentIdentities.ownerUserId, input.ownerUserId)))
      .returning({ userId: agentIdentities.userId });
    if (released.length === 0) return { ok: false } as const;

    await tx.update(users).set({ emailVerified: null }).where(eq(users.id, input.agentUserId));
    await tx
      .update(agentClaims)
      .set({ deniedAt: input.now })
      .where(and(
        eq(agentClaims.agentUserId, input.agentUserId),
        isNull(agentClaims.approvedAt),
        isNull(agentClaims.deniedAt),
        isNull(agentClaims.redeemedAt),
      ));
    return { ok: true } as const;
  }));
}
