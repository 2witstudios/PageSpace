/**
 * The gate for a model call that belongs to a turn but runs outside it: the context
 * compaction a chat turn schedules once its own call has settled, or that ask_agent starts
 * while its caller is still streaming (SPEND-1).
 *
 * It spends where the turn spent. The caller passes the turn's target with the source the
 * turn's gate resolved already pinned (resolvedSpend), so the follow-on call can neither
 * move to a different wallet (SPEND-4) nor reach a person's credits from an automation's
 * turn (SPEND-6). It is gated and reserved before the model runs, like every other call, and
 * settles once against that reservation. A flat-rate (metering-exempt) provider reserves
 * nothing, as the turn itself did not.
 *
 * Pure: the caller runs the gate (canConsumeAI) with what this returns.
 */

import type { SpendTarget } from './spend-target';

export type FollowOnAdmission =
  | { readonly gate: false }
  | { readonly gate: true; readonly spend: SpendTarget; readonly estCostCents: number };

export function followOnAdmission(input: {
  meteringExempt: boolean;
  turnSpend: SpendTarget;
  estCostCents: number;
}): FollowOnAdmission {
  if (input.meteringExempt) return { gate: false };
  // A metered call always holds something: a zero reservation would let an empty wallet
  // through the gate's coverage check.
  const estCostCents = Number.isFinite(input.estCostCents) && input.estCostCents > 0 ? Math.ceil(input.estCostCents) : 1;
  return { gate: true, spend: input.turnSpend, estCostCents };
}
