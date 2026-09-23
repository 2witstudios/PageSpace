import { calculateCost } from '@pagespace/lib/monitoring/ai-monitoring';
import { MARKUP_BPS } from '@pagespace/lib/billing/credit-pricing';

/**
 * The real (pre-markup) cost of a model step that was cut off by an abort.
 *
 * ai@6 reports no usage for an interrupted step, but the provider has already
 * charged for it: the prompt it read and the output it streamed. Billing it at
 * $0 makes "abort just before the end" a free answer. The policy (one call for
 * every AI route, set with the chat route's interrupted step in #2695):
 *
 *  - input: estimated tokens of the prompt that was sent;
 *  - output: estimated tokens of what streamed before the abort, nothing more;
 *  - priced at the model's catalog rate (`calculateCost`); the markup applies at
 *    settle as usual;
 *  - capped at the hold the credit gate reserved for the call, converted back
 *    through the markup, so a wrong estimate never charges more than the user
 *    was told could be spent.
 *
 * Callers pass the token counts (counted with the same `estimateTokens` the
 * reservation uses) and the call's hold in cents.
 */
export function priceInterruptedStep(input: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  holdCents: number;
}): { costDollars: number; capped: boolean } {
  const estimatedDollars = calculateCost(input.model, input.inputTokens, input.outputTokens);
  const capDollars = input.holdCents / 100 / (MARKUP_BPS / 10000);
  return { costDollars: Math.min(estimatedDollars, capDollars), capped: estimatedDollars > capDollars };
}
