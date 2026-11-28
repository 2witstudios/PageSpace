/**
 * Whose OWN CREDITS a call spends (ADR 0008 Decision 8 "owner pays", Agent
 * Signup Phase 4).
 *
 * Master's wallet model names every call's wallet before it runs (spend-target,
 * SPEND-1): a drive wallet, a seat on an org pool, or "own credits" — the
 * caller's personal root wallet. A claimed agent's own credits ARE its owner's:
 * this is the one place that says so. The credit gate asks it once per billed
 * call and then reads, locks, lazily initialises and holds against the PAYER's
 * personal root at the PAYER's tier, while the hold, the in-flight count and
 * the daily exposure cap stay the agent's own (the agent is still the consumer).
 * consumeCredits and releaseHold follow the hold's wallet, so the owner's wallet
 * is what settles — the agent's own wallet row is never touched. Drive wallets
 * and seats keep master's rules: they are not anyone's own credits.
 *
 * The decision itself is the frozen `resolveBillingPayer`; this module only
 * performs the lookup it takes as input.
 *
 * @module @pagespace/lib/billing/agent-billing-owner
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { agentIdentities } from '@pagespace/db/schema/agent-identities';
import { resolveBillingPayer } from './agent-payer';
import { toPersonalSubscriptionTier } from './subscription-tiers';
import type { SubscriptionTier } from './subscription-tiers';

export interface AgentBillingOwner {
  ownerUserId: string;
  /** The owner's stored `users.subscriptionTier`, normalised by the caller. */
  ownerTier: string | null;
}

export type LookupAgentBillingOwner = (userId: string) => Promise<AgentBillingOwner | null>;

/**
 * The owner of a LIVE agent identity, with the owner's stored tier. Null for a
 * human (no identity row), an unclaimed agent, and a revoked agent — a revoked
 * agent's spend never reaches its owner, it pays as itself (and has nothing).
 * One primary-key read of `agent_identities` (every human stops there), and for a
 * claimed agent one more for the owner's tier.
 */
export async function lookupAgentBillingOwner(userId: string): Promise<AgentBillingOwner | null> {
  const [identity] = await db
    .select({ ownerUserId: agentIdentities.ownerUserId, revokedAt: agentIdentities.revokedAt })
    .from(agentIdentities)
    .where(eq(agentIdentities.userId, userId))
    .limit(1);
  if (!identity?.ownerUserId || identity.revokedAt) return null;
  const [owner] = await db
    .select({ subscriptionTier: users.subscriptionTier })
    .from(users)
    .where(eq(users.id, identity.ownerUserId))
    .limit(1);
  return owner ? { ownerUserId: identity.ownerUserId, ownerTier: owner.subscriptionTier } : null;
}

export interface OwnCreditsPayer {
  /** Whose personal root wallet "own credits" means for this call. */
  payerId: string;
  /** The tier that governs that wallet: the owner's for a claimed agent, else the caller's. */
  tier: SubscriptionTier;
  /** True iff a claimed agent's owner pays. */
  viaAgentOwner: boolean;
}

export async function resolveOwnCreditsPayer(input: {
  userId: string;
  tier: SubscriptionTier;
  lookup?: LookupAgentBillingOwner;
}): Promise<OwnCreditsPayer> {
  const owner = await (input.lookup ?? lookupAgentBillingOwner)(input.userId);
  const payer = resolveBillingPayer({ userId: input.userId, ownerUserId: owner?.ownerUserId ?? null });
  if (!payer.viaAgentOwner || owner === null) {
    return { payerId: input.userId, tier: input.tier, viaAgentOwner: false };
  }
  return { payerId: payer.payerId, tier: toPersonalSubscriptionTier(owner.ownerTier), viaAgentOwner: true };
}
