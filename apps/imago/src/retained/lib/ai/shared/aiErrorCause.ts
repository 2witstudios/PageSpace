/**
 * A typed classification of an AI chat error (epic leaf 6.5), replacing string
 * re-parsing of `error.message`. Attached as `Error.cause` — see `toErrorCause`
 * (real path, from a fetch response) and `parseLegacyErrorMessage` (transitional
 * string-shaped fallback).
 */
export interface AIErrorCause {
  code: 'auth' | 'out_of_credits' | 'too_many_in_flight' | 'daily_cap_exceeded' | 'rate_limit' | 'unknown';
  /** The HTTP status, when known from a real response. null for the legacy string path. */
  httpStatus: number | null;
  /** User-facing copy — never the raw server/JSON body. */
  message: string;
  /** Whether the user can reasonably retry (vs. needing to buy credits / wait for a reset). */
  retryable: boolean;
}

const AI_ERROR_CODES: ReadonlySet<AIErrorCause['code']> = new Set([
  'auth',
  'out_of_credits',
  'too_many_in_flight',
  'daily_cap_exceeded',
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
    (cause.httpStatus === null || Number.isInteger(cause.httpStatus))
  );
};
