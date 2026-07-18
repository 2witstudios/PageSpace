import type { AIErrorCause } from './aiErrorCause';
import { buildErrorCause, toErrorCause } from './toErrorCause';

// Narrow patterns so the classifier keys off the gate's exact codes/statuses and
// specific phrases — NOT bare substrings. `limit` alone would misclassify
// "context window limit exceeded" as a transient rate limit, and `ai credits`
// alone would route any message merely mentioning credits to the buy-more CTA.
const OUT_OF_CREDITS_PATTERNS = [/\bout_of_credits\b/, /\b402\b/, /\bout of credits\b/];
const IN_FLIGHT_PATTERNS = [/\btoo_many_in_flight\b/, /\bin[-\s]flight\b/];
const RATE_LIMIT_PATTERNS = [
  /\brate limit\b/,
  /\btoo many requests\b/,
  /\b429\b/,
  /\bfailed after \d+ retr/,
  /\bprovider returned error\b/,
];

const classifyByPattern = (message: string): AIErrorCause['code'] => {
  const msg = message.toLowerCase();
  if (msg.includes('unauthorized') || msg.includes('401')) return 'auth';
  if (OUT_OF_CREDITS_PATTERNS.some((p) => p.test(msg))) return 'out_of_credits';
  if (IN_FLIGHT_PATTERNS.some((p) => p.test(msg))) return 'too_many_in_flight';
  if (RATE_LIMIT_PATTERNS.some((p) => p.test(msg))) return 'rate_limit';
  return 'unknown';
};

/**
 * TRANSITIONAL (deletion covenant, page kw69qhfck96jpssdk6w2xtbp) — the ONE
 * surviving string parser. `toErrorCause` (real path) fires whenever a
 * request goes through `createStreamTrackingFetch`, which reads the response
 * status and body directly; this adapter exists only for whatever still
 * reaches the client as a bare message string (a genuine network failure
 * before any response arrives, or an error surfaced by a path this epic
 * doesn't touch). `httpStatus` is always null here — there is no real
 * response to read one from. DELETE ME at the SDK 7 transport swap,
 * alongside the own-stream mirror and hydrateTransportBeforeReinvoke.
 */
export const parseLegacyErrorMessage = (message: string | undefined): AIErrorCause => {
  if (!message) return buildErrorCause('unknown', null, undefined);

  // The message may BE the response body JSON that createStreamTrackingFetch failed to
  // intercept for some reason (a code path outside this epic) — reuse the real
  // classifier's known-code list over the parsed body rather than duplicating it.
  try {
    const parsed = JSON.parse(message);
    if (typeof parsed === 'object' && parsed !== null) {
      return { ...toErrorCause(0, parsed), httpStatus: null };
    }
  } catch {
    // Not JSON — fall through to phrase matching.
  }

  return buildErrorCause(classifyByPattern(message), null, undefined);
};
