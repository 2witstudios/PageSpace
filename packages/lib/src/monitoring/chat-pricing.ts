/**
 * chat-pricing — the per-call HOLD estimate for chat/text AI calls.
 *
 * The credit gate reserves a hold before a call runs, but the real token counts (and
 * therefore the real cost) aren't known until the stream finishes — the real cost
 * always settles exactly via consumeCredits on the OpenRouter-reported figure. So the
 * hold is only a pre-settle BOUND. We make it model-aware (a pricey model reserves
 * more than a cheap one) by pricing an assumed per-call token budget against the model
 * catalog, marking it up, and clamping to [CHAT_HOLD_FLOOR_CENTS, RESERVE_FLOOR_CENTS].
 *
 * This is the impure shell (catalog lookup + config); the markup+clamp math is the pure
 * {@link estimateChatHoldCents} in credit-core. Mirrors voice-pricing's
 * estimateVoiceHoldCents. Holds are hidden from the displayed balance (see
 * getCreditBalance), so this only affects gate enforcement, not the navbar number.
 */

import { calculateCost, AI_PRICING } from './ai-monitoring';
import { estimateChatHoldCents, markupCents } from '../billing/credit-core';
import {
  MARKUP_BPS,
  CHAT_HOLD_FLOOR_CENTS,
  CHAT_HOLD_ASSUMED_INPUT_TOKENS,
  CHAT_HOLD_ASSUMED_OUTPUT_TOKENS,
  CREDIT_HOLD_ESTIMATE_CENTS,
} from '../billing/credit-pricing';

/**
 * Conservative per-step cost (dollars) used when a model is not in the catalog.
 * `calculateCost` returns 0 for unknown models (the catalog `default` has $0 rates),
 * which would leave the mid-stream abort guard permanently inactive for uncatalogued
 * but potentially expensive models. This fallback converts the legacy flat hold
 * (CREDIT_HOLD_ESTIMATE_CENTS) back to dollars — after markup it charges exactly
 * CREDIT_HOLD_ESTIMATE_CENTS per step, bounding uncatalogued-model runs.
 */
const UNKNOWN_MODEL_FALLBACK_DOLLARS = CREDIT_HOLD_ESTIMATE_CENTS / (MARKUP_BPS / 10000) / 100;

/**
 * Cost in dollars for one AI SDK step. Unknown/uncatalogued models use a conservative
 * fallback (UNKNOWN_MODEL_FALLBACK_DOLLARS) so the mid-stream abort still fires rather
 * than letting an uncatalogued model run without bound. Known free models ($0 catalog
 * rate) correctly return 0. Returns the fallback on any pricing error.
 * Pure — no side effects.
 */
export function calcStepCostDollars(
  model: string,
  usage: { inputTokens?: number | undefined; outputTokens?: number | undefined },
): number {
  try {
    const cost = calculateCost(model, usage.inputTokens ?? 0, usage.outputTokens ?? 0);
    if (cost > 0) return cost;
    // cost === 0: either a known free model OR an unknown model that hit the $0 default.
    // Unknown models should use the conservative fallback; known free models return 0.
    return Object.prototype.hasOwnProperty.call(AI_PRICING, model)
      ? 0
      : UNKNOWN_MODEL_FALLBACK_DOLLARS;
  } catch {
    return UNKNOWN_MODEL_FALLBACK_DOLLARS;
  }
}

/**
 * True when the user's remaining spendable credits (after applying the markup on
 * cumulative cost so far) are at or below the reserve floor. Abort the stream.
 * Pure — no side effects.
 */
export function shouldAbortAfterStep(input: {
  cumulativeCostDollars: number;
  balanceCents: number;
  markupBps: number;
  reserveFloorCents: number;
}): boolean {
  const chargedSoFarCents = markupCents(input.cumulativeCostDollars, input.markupBps);
  return input.balanceCents - chargedSoFarCents <= input.reserveFloorCents;
}

/**
 * Whole-cent hold reservation for one chat call against `model`. Prices the assumed
 * per-call token budget (or a caller-supplied `inputTokens` estimate, when cheaply
 * available) at the catalog rate, applies the markup, and clamps to
 * [CHAT_HOLD_FLOOR_CENTS, CREDIT_HOLD_ESTIMATE_CENTS] — never below a sane minimum nor
 * above the legacy flat chat hold.
 *
 * An UNKNOWN or absent model (not in the catalog) falls back to the legacy flat hold
 * rather than being priced: the catalog default rate is $0, which would otherwise clamp
 * a real call down to the floor and weaken the gate. A KNOWN free model (input/output
 * both $0, e.g. gpt-oss) legitimately prices to the floor — that's fine.
 */
export function estimateChatHoldCentsForModel(
  model: string | undefined,
  opts: { inputTokens?: number } = {},
): number {
  if (!model || !Object.prototype.hasOwnProperty.call(AI_PRICING, model)) {
    return CREDIT_HOLD_ESTIMATE_CENTS;
  }
  const inputTokens =
    typeof opts.inputTokens === 'number' && opts.inputTokens > 0
      ? opts.inputTokens
      : CHAT_HOLD_ASSUMED_INPUT_TOKENS;
  const estDollars = calculateCost(model, inputTokens, CHAT_HOLD_ASSUMED_OUTPUT_TOKENS);
  return estimateChatHoldCents(
    estDollars,
    MARKUP_BPS,
    CHAT_HOLD_FLOOR_CENTS,
    CREDIT_HOLD_ESTIMATE_CENTS,
  );
}
