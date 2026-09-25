/**
 * A typed classification of an AI chat error (epic leaf 6.5), replacing string
 * re-parsing of `error.message`. Attached as `Error.cause` — see `toErrorCause`
 * (real path, from a fetch response) and `parseLegacyErrorMessage` (transitional
 * string-shaped fallback).
 */
export interface AIErrorCause {
  code:
    | 'auth'
    | 'out_of_credits'
    | 'too_many_in_flight'
    | 'daily_cap_exceeded'
    | 'spend_source_refused'
    | 'rate_limit'
    | 'unknown';
  /** The HTTP status, when known from a real response. null for the legacy string path. */
  httpStatus: number | null;
  /** User-facing copy — never the raw server/JSON body. */
  message: string;
  /** Whether the user can reasonably retry (vs. needing to buy credits / wait for a reset). */
  retryable: boolean;
  /**
   * SPEND-4: on `spend_source_refused`, the source the call named (null when several
   * existed and none was chosen), why it was refused, and the sources the person may pick
   * instead — the 402 body's `source` / `refusalReason` / `options`, kept for the picker.
   */
  refusal?: AISpendRefusal;
}

export interface AISpendRefusal {
  source: string | null;
  reason: string;
  options: string[];
}

/** The refusal shape, validated field by field (server-authored, but crosses the wire). */
export const isAISpendRefusal = (value: unknown): value is AISpendRefusal => {
  if (typeof value !== 'object' || value === null) return false;
  const refusal = value as Record<string, unknown>;
  return (
    (refusal.source === null || typeof refusal.source === 'string') &&
    typeof refusal.reason === 'string' &&
    Array.isArray(refusal.options) &&
    refusal.options.every((option) => typeof option === 'string')
  );
};

const AI_ERROR_CODES: ReadonlySet<AIErrorCause['code']> = new Set([
  'auth',
  'out_of_credits',
  'too_many_in_flight',
  'daily_cap_exceeded',
  'spend_source_refused',
  'rate_limit',
  'unknown',
]);

/**
 * Narrows an Error's `.cause` (unknown by the DOM lib types) to a real
 * AIErrorCause. Validates the full shape, not just key presence — an arbitrary
 * `.cause` (a third-party lib, a future code path this epic doesn't own) with
 * a wrong-typed field would otherwise be trusted downstream, potentially
 * crashing React while rendering `message` or showing the wrong billing CTA
 * (PR 6 review, CodeRabbit).
 */
export const isAIErrorCause = (value: unknown): value is AIErrorCause => {
  if (typeof value !== 'object' || value === null) return false;
  const cause = value as Record<string, unknown>;
  return (
    typeof cause.code === 'string' &&
    AI_ERROR_CODES.has(cause.code as AIErrorCause['code']) &&
    typeof cause.retryable === 'boolean' &&
    typeof cause.message === 'string' &&
    (cause.httpStatus === null || Number.isInteger(cause.httpStatus)) &&
    (cause.refusal === undefined || isAISpendRefusal(cause.refusal))
  );
};
