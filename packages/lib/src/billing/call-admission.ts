/**
 * What a model call made outside a request turn reserves before it runs (SPEND-1): the
 * context compaction a chat turn schedules once its own call has settled (or that ask_agent
 * starts while its caller is still streaming), and each model call of the nightly memory cron.
 *
 * The caller names the target. A compaction passes its turn's target with the source the
 * turn's gate resolved already pinned (resolvedSpend), so it can neither move to a different
 * wallet (SPEND-4) nor reach a person's credits from an automation's turn (SPEND-6). The
 * memory cron passes the person's own credits: it learns their personal profile, outside
 * any drive (SPEND-8).
 *
 * Every metered call is gated and reserved before the model runs, and settles once against
 * that reservation. A flat-rate (metering-exempt) provider reserves nothing: its usage is
 * never debited, and its turn did not reserve either.
 *
 * Pure: the caller runs the gate (canConsumeAI) with what this returns.
 */

import type { SpendTarget } from './spend-target';

export type CallAdmission =
  | { readonly gate: false }
  | { readonly gate: true; readonly spend: SpendTarget; readonly estCostCents: number };

export function callAdmission(input: {
  meteringExempt: boolean;
  spend: SpendTarget;
  estCostCents: number;
}): CallAdmission {
  if (input.meteringExempt) return { gate: false };
  // A metered call always holds something: a zero reservation would let an empty wallet
  // through the gate's coverage check.
  const estCostCents = Number.isFinite(input.estCostCents) && input.estCostCents > 0 ? Math.ceil(input.estCostCents) : 1;
  return { gate: true, spend: input.spend, estCostCents };
}
