import type { CreditGateResult } from '@pagespace/lib/billing/credit-gate';
import { PERSONAL_SPEND, resolvedSpend, type SpendTarget } from '@pagespace/lib/billing/spend-target';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';

/**
 * What a chat turn's credit gate named, shared by the page and global turns so the two
 * cannot drift on it:
 *   - `spend`: the turn's spend target, naming the source the gate resolved, so a tool that
 *     gates its own model call (generate_image) names the same wallet (SPEND-4). It is also
 *     the shape `ToolExecutionContext.creditSpend` carries.
 *   - `walletId`: the wallet the hold was placed on, settled against with it (WAL-5).
 *   - `entitlementTier`: the tier of whoever funds the call, for the pro-model gate (WAL-8).
 */
export interface TurnCredit {
  spend: SpendTarget;
  walletId?: string;
  entitlementTier?: SubscriptionTier;
}

/** A turn that has not gated (yet, or at all: a flat-rate provider, a solo /help). */
export const UNGATED_TURN_CREDIT: TurnCredit = Object.freeze({ spend: PERSONAL_SPEND });

/** The turn's credit once its gate allowed the call against `spend`. */
export function turnCreditAfterGate(spend: SpendTarget, gate: CreditGateResult): TurnCredit {
  return {
    spend: resolvedSpend(spend, gate.spendSource),
    walletId: gate.walletId,
    entitlementTier: gate.entitlementTier,
  };
}
