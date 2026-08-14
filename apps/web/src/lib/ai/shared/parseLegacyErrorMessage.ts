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
 * The fallback for errors that arrive as a bare message string, with no response behind them.
 *
 * THIS IS PERMANENT NOW. It carried a deletion marker scheduling it to go "at the SDK 7
 * transport swap, alongside the own-stream mirror and hydrateTransportBeforeReinvoke" — that
 * swap has happened (`useChatSession` replaced `useChat`), both of those modules are deleted,
 * and this one is still needed. The marker is removed rather than re-dated: a deletion gate
 * that keeps slipping is one nobody believes.
 *
 * It is needed because the swap did not remove the case it covers. `toErrorCause` is the real
 * path and fires whenever a request reaches a RESPONSE: `useChatSession` reads the status and
 * body directly and throws a typed cause. But a genuine network failure — DNS, a dropped
 * connection, an offline tab — rejects the `fetch` before any response exists, and what
 * surfaces is a message string and nothing else. `httpStatus` is always null here for exactly
 * that reason: there is no response to read one from.
 *
 * So this is a permanent fallback for a permanent case, not scaffolding awaiting a swap.
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
