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

/** Narrows an Error's `.cause` (unknown by the DOM lib types) to a real AIErrorCause. */
export const isAIErrorCause = (value: unknown): value is AIErrorCause =>
  typeof value === 'object' &&
  value !== null &&
  'code' in value &&
  'retryable' in value &&
  'message' in value;
