/**
 * The "own credits" balance a person sees (ADR 0008 Decision 8, owner pays;
 * Agent Signup Phase 5b).
 *
 * The credit gate charges a claimed agent's own-credits spend to its OWNER's
 * personal root wallet (resolveOwnCreditsPayer). Every surface that shows "your
 * credits" must read the same wallet, or a claimed agent looks unfunded while
 * its calls go through. This module is that read: the payer comes from the one
 * seam, the balance from the display read model, and for a claimed agent it
 * names whom the spend is billed to. A human and an unclaimed agent read their
 * own wallet exactly as before (an unclaimed agent keeps the requires-funding
 * path: its balance is empty and names no payer).
 *
 * @module @pagespace/lib/billing/own-credits-balance
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { decryptUserRow } from '../auth/user-repository';
import { resolveOwnCreditsPayer, type OwnCreditsPayer } from './agent-billing-owner';
import { getCreditBalance, type CreditBalanceSummary } from './credit-balance';
import type { SubscriptionTier } from './subscription-tiers';

/** Whom a claimed agent's own-credits spend is billed to. */
export interface BilledTo {
  userId: string;
  name: string;
}

export interface OwnCreditsBalance extends CreditBalanceSummary {
  /** The tier whose allowance this balance is: the owner's for a claimed agent. */
  subscriptionTier: SubscriptionTier;
  /** Set only for a claimed agent: the balance shown is its owner's. */
  billedTo: BilledTo | null;
}

export interface OwnCreditsBalanceDeps {
  resolvePayer: (input: { userId: string; tier: SubscriptionTier }) => Promise<OwnCreditsPayer>;
  readBalance: (userId: string, tier: SubscriptionTier) => Promise<CreditBalanceSummary>;
  readName: (userId: string) => Promise<string>;
}

/** A user's display name, decrypted (names are field-encrypted at rest). Empty when absent. */
export async function readUserDisplayName(userId: string): Promise<string> {
  const [row] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  if (!row) return '';
  return (await decryptUserRow({ name: row.name })).name ?? '';
}

const DEFAULT_DEPS: OwnCreditsBalanceDeps = {
  resolvePayer: (input) => resolveOwnCreditsPayer(input),
  readBalance: getCreditBalance,
  readName: readUserDisplayName,
};

export async function getOwnCreditsBalance(
  userId: string,
  tier: SubscriptionTier,
  deps: OwnCreditsBalanceDeps = DEFAULT_DEPS,
): Promise<OwnCreditsBalance> {
  const payer = await deps.resolvePayer({ userId, tier });
  const summary = await deps.readBalance(payer.payerId, payer.tier);
  const billedTo = payer.viaAgentOwner ? { userId: payer.payerId, name: await deps.readName(payer.payerId) } : null;
  return { ...summary, subscriptionTier: payer.tier, billedTo };
}
