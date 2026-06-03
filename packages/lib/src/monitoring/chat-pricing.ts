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
import { estimateChatHoldCents } from '../billing/credit-core';
import {
  MARKUP_BPS,
  CHAT_HOLD_FLOOR_CENTS,
  CHAT_HOLD_ASSUMED_INPUT_TOKENS,
  CHAT_HOLD_ASSUMED_OUTPUT_TOKENS,
  CREDIT_HOLD_ESTIMATE_CENTS,
} from '../billing/credit-pricing';

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
  if (!model || !(model in AI_PRICING)) {
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
