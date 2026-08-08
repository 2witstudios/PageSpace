import { calcStepCostDollars, shouldAbortAfterStep } from '@pagespace/lib/monitoring/chat-pricing';
import { MARKUP_BPS, RESERVE_FLOOR_CENTS } from '@pagespace/lib/billing/credit-pricing';

/**
 * Returns a per-step cost accumulator that aborts the stream once the user's
 * available balance (minus accumulated real-cost markup) falls to or below the
 * reserve floor. Used via onStepFinish in streamText.
 */
export function makeOnStepFinishHandler(
  creditAbortController: AbortController,
  availableBalanceCents: number,
  model: string,
): (usage: { inputTokens?: number | undefined; outputTokens?: number | undefined }) => void {
  let cumulativeCostDollars = 0;
  return (usage) => {
    cumulativeCostDollars += calcStepCostDollars(model, usage);
    if (shouldAbortAfterStep({
      cumulativeCostDollars,
      balanceCents: availableBalanceCents,
      markupBps: MARKUP_BPS,
      reserveFloorCents: RESERVE_FLOOR_CENTS,
    })) {
      creditAbortController.abort();
    }
  };
}
