import type { CreditGateResult, SpendFallback } from '@pagespace/lib/billing/credit-gate';
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
 *   - `fallback`: set only when the drive's rule moved the turn off the source it named
 *     (SPEND-4): the turn tells the client, never switching silently.
 */
export interface TurnCredit {
  spend: SpendTarget;
  walletId?: string;
  entitlementTier?: SubscriptionTier;
  fallback?: SpendFallback;
}

/** A turn that has not gated (yet, or at all: a flat-rate provider, a solo /help). */
export const UNGATED_TURN_CREDIT: TurnCredit = Object.freeze({ spend: PERSONAL_SPEND });

/** The turn's credit once its gate allowed the call against `spend`. */
export function turnCreditAfterGate(spend: SpendTarget, gate: CreditGateResult): TurnCredit {
  return {
    spend: resolvedSpend(spend, gate.spendSource),
    walletId: gate.walletId,
    entitlementTier: gate.entitlementTier,
    ...(gate.fallback ? { fallback: gate.fallback } : {}),
  };
}

/** The assistant-message data part that tells the client a turn fell back (SPEND-4). */
export const SPEND_FALLBACK_PART_TYPE = 'data-spend-fallback' as const;

export interface SpendFallbackPart {
  type: typeof SPEND_FALLBACK_PART_TYPE;
  id: string;
  data: SpendFallback & { walletId: string | null };
}

/**
 * The part a turn writes first when its gate fell back — the source it moved from and to,
 * and the wallet actually held — so the chip and strip can show the new source. Null when
 * the turn spent the source it named.
 */
export function spendFallbackPart(credit: TurnCredit, messageId: string): SpendFallbackPart | null {
  if (!credit.fallback) return null;
  return {
    type: SPEND_FALLBACK_PART_TYPE,
    id: `${messageId}-spend-fallback`,
    data: { from: credit.fallback.from, to: credit.fallback.to, walletId: credit.walletId ?? null },
  };
}
