/**
 * Adding up what a call cost, one response at a time.
 *
 * `usage` is per RESPONSE — measured, and it is the fact the whole metering
 * design hangs off. Every `response.done` reports what that one response spent;
 * a CALL total exists only because something keeps the running sum. This is
 * that something, and it is pure so the arithmetic can be checked without a
 * socket, a clock or a ledger.
 *
 * Two asymmetries in the wire shape are preserved rather than smoothed away,
 * because `calculateRealtimeCostDollars` prices from the per-modality DETAIL
 * blocks and ignores the totals — an accumulator that summed only
 * `input_tokens`/`output_tokens` would produce a tidy number that bills zero:
 *   - caching is INPUT-ONLY: there is no cached figure on the output side;
 *   - `cached_tokens` is a SUBSET of `input_tokens`, never an addition, so it
 *     is summed as its own subtotal and never folded into the gross.
 *
 * Pure: no I/O, no clock, no randomness, no module-level mutable state.
 */

import type {
  RealtimeCachedTokenDetails,
  RealtimeUsage,
} from '@pagespace/lib/monitoring/voice-pricing';

/** Anything not a finite, non-negative number contributes nothing. */
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

const addCachedDetails = (
  a: RealtimeCachedTokenDetails | undefined,
  b: RealtimeCachedTokenDetails | undefined,
): RealtimeCachedTokenDetails | undefined => {
  if (!a && !b) return undefined;
  return {
    text_tokens: count(a?.text_tokens) + count(b?.text_tokens),
    audio_tokens: count(a?.audio_tokens) + count(b?.audio_tokens),
    image_tokens: count(a?.image_tokens) + count(b?.image_tokens),
  };
};

/**
 * Sum two usage objects into one.
 *
 * Associative and commutative over well-formed input, and total over malformed
 * input: a frame with a `null` usage, a string where a number should be, or no
 * detail blocks at all adds zero rather than poisoning the running sum with
 * `NaN`. A `NaN` here would propagate into the cost and from there into the
 * ledger, which is the one place a wire-shape surprise must not reach.
 *
 * The detail blocks are materialized whenever EITHER side has one, so a total
 * built from partial frames still prices — the pricing function reads only the
 * detail blocks, so dropping them because one frame lacked them would silently
 * bill the call at zero.
 */
export const addUsage = (
  total: RealtimeUsage | undefined,
  next: RealtimeUsage | undefined,
): RealtimeUsage => {
  const a = total ?? {};
  const b = next ?? {};

  const inputA = a.input_token_details;
  const inputB = b.input_token_details;
  const outputA = a.output_token_details;
  const outputB = b.output_token_details;

  return {
    input_tokens: count(a.input_tokens) + count(b.input_tokens),
    output_tokens: count(a.output_tokens) + count(b.output_tokens),
    total_tokens: count(a.total_tokens) + count(b.total_tokens),
    ...(inputA || inputB
      ? {
          input_token_details: {
            text_tokens: count(inputA?.text_tokens) + count(inputB?.text_tokens),
            audio_tokens: count(inputA?.audio_tokens) + count(inputB?.audio_tokens),
            image_tokens: count(inputA?.image_tokens) + count(inputB?.image_tokens),
            // A SUBSET of the gross figures above, kept as its own subtotal so
            // the cache-read rate applies to it and the full rate to the
            // remainder — never both to the same token.
            cached_tokens: count(inputA?.cached_tokens) + count(inputB?.cached_tokens),
            ...(addCachedDetails(inputA?.cached_tokens_details, inputB?.cached_tokens_details)
              ? {
                  cached_tokens_details: addCachedDetails(
                    inputA?.cached_tokens_details,
                    inputB?.cached_tokens_details,
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(outputA || outputB
      ? {
          output_token_details: {
            text_tokens: count(outputA?.text_tokens) + count(outputB?.text_tokens),
            audio_tokens: count(outputA?.audio_tokens) + count(outputB?.audio_tokens),
          },
        }
      : {}),
  };
};

/** True when nothing was actually spent — used to skip an empty settle. */
export const isUsageEmpty = (usage: RealtimeUsage | undefined): boolean => {
  if (!usage) return true;
  const input = usage.input_token_details;
  const output = usage.output_token_details;
  return (
    count(usage.input_tokens) === 0 &&
    count(usage.output_tokens) === 0 &&
    count(usage.total_tokens) === 0 &&
    count(input?.text_tokens) === 0 &&
    count(input?.audio_tokens) === 0 &&
    count(input?.image_tokens) === 0 &&
    count(output?.text_tokens) === 0 &&
    count(output?.audio_tokens) === 0
  );
};

/**
 * True when a usage object reports totals but attributes NONE of them to a
 * modality.
 *
 * `calculateRealtimeCostDollars` deliberately refuses to guess a modality for
 * an unattributed total — audio input costs eight times text input, so guessing
 * over-charges half the time — and bills it at zero. That is the right call
 * there and the wrong thing to be silent about here: this is the layer that can
 * see the whole session, so it is the layer that reports a payload shape which
 * would otherwise show up only as a suspiciously cheap call.
 */
export const hasUnattributedTokens = (usage: RealtimeUsage | undefined): boolean => {
  if (!usage) return false;
  const reported = count(usage.input_tokens) + count(usage.output_tokens);
  if (reported === 0) return false;
  const input = usage.input_token_details;
  const output = usage.output_token_details;
  const attributed =
    count(input?.text_tokens) +
    count(input?.audio_tokens) +
    count(input?.image_tokens) +
    count(output?.text_tokens) +
    count(output?.audio_tokens);
  return attributed === 0;
};
