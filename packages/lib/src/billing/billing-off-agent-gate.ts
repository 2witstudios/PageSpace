/**
 * billingOffAgentGate — agents get no free AI where prepaid billing is off
 * (ADR 0007 Decision 9; tenant and onprem deployments).
 *
 * With billing off, `canConsumeAI` answers `unlimited` for everyone: the
 * customer running the deployment pays the AI bill. Without this decision every
 * signed-up agent would spend that bill freely. An unclaimed agent therefore
 * requires funding (a human claiming it); a claimed agent is unlimited like its
 * owner; a human is never affected.
 *
 * Pure: the account lookup RESULT is the input, never the lookup.
 *
 * @module @pagespace/lib/billing/billing-off-agent-gate
 */

import type { AccountType } from '../auth/agent/account-type';

export interface BillingOffAgentGateInput {
  accountType: AccountType;
  /** True when `agent_identities.ownerUserId` is set (a claimed agent). */
  hasOwner: boolean;
}

export type BillingOffAgentGateDecision = 'allow' | 'requires_funding';

export function billingOffAgentGate(input: BillingOffAgentGateInput): BillingOffAgentGateDecision {
  if (input.accountType === 'agent' && !input.hasOwner) return 'requires_funding';
  return 'allow';
}
