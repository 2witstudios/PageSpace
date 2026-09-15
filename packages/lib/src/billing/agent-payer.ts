/**
 * resolveBillingPayer — the ONE seam that names who pays for a user's AI
 * spend (ADR 0005 Decision 8, "owner pays").
 *
 * A claimed agent's spend lands on its owner's balance at the owner's tier;
 * everyone else (a human, an unclaimed agent) pays as themselves. Phase 4
 * consults this at exactly three places — `canConsumeAI`, `consumeCredits`,
 * `releaseHold` — and injects the `agent_accounts.ownerUserId` lookup; the
 * thirteen gate callers never see it. Twin of `resolveSessionPayerId`
 * (`sandbox-payer.ts`) for the agent case.
 *
 * Pure: the lookup RESULT is the input, never the lookup.
 *
 * @module @pagespace/lib/billing/agent-payer
 */

export interface ResolveBillingPayerInput {
  /** The principal making the call. */
  userId: string;
  /** `agent_accounts.ownerUserId` for that principal — null/empty when unclaimed or not an agent. */
  ownerUserId: string | null;
}

export interface BillingPayer {
  payerId: string;
  /** True iff the payer is someone other than the caller — a claimed agent's owner. */
  viaAgentOwner: boolean;
}

export function resolveBillingPayer(input: ResolveBillingPayerInput): BillingPayer {
  const owner = input.ownerUserId;
  if (owner === null || owner === '' || owner === input.userId) {
    return { payerId: input.userId, viaAgentOwner: false };
  }
  return { payerId: owner, viaAgentOwner: true };
}
