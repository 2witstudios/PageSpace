/**
 * User-friendly error messages for AI chat errors.
 *
 * The credit gate denies AI requests with two distinct statuses (see
 * `apps/web/src/lib/subscription/credit-gate-response.ts`):
 *   - 402 `out_of_credits`       — the prepaid balance is exhausted; the user must
 *                                  buy more credits or wait for the monthly reset.
 *   - 429 `too_many_in_flight`   — the free-tier concurrency cap; wait for an
 *                                  in-flight call to finish, then retry.
 * The thrown client error carries the status code and the JSON error body, so we
 * branch on those tokens to show the right copy and the right call to action.
 */

export type AIErrorKind =
  | 'auth'
  | 'out_of_credits'
  | 'too_many_in_flight'
  | 'rate_limit'
  | 'generic';

// Narrow patterns so the classifier keys off the gate's exact codes/statuses and
// specific phrases — NOT bare substrings. `limit` alone would misclassify
// "context window limit exceeded" as a transient rate limit, and `ai credits`
// alone would route any message merely mentioning credits to the buy-more CTA.
const OUT_OF_CREDITS_PATTERNS = [/\bout_of_credits\b/, /\b402\b/, /\bout of ai credits\b/];
const IN_FLIGHT_PATTERNS = [/\btoo_many_in_flight\b/, /\bin[-\s]flight\b/];
const RATE_LIMIT_PATTERNS = [
  /\brate limit\b/,
  /\btoo many requests\b/,
  /\b429\b/,
  /\bfailed after \d+ retr/,
  /\bprovider returned error\b/,
];

/** Classify a chat error message into a coarse kind that drives copy + CTA. */
export function classifyAIError(errorMessage: string | undefined): AIErrorKind {
  if (!errorMessage) return 'generic';
  const msg = errorMessage.toLowerCase();

  if (msg.includes('unauthorized') || msg.includes('401')) return 'auth';

  // Out of prepaid credits (402) — exact code/status or the gate's human phrasing.
  if (OUT_OF_CREDITS_PATTERNS.some((p) => p.test(msg))) return 'out_of_credits';

  // Free-tier in-flight concurrency cap (429, distinct error code).
  if (IN_FLIGHT_PATTERNS.some((p) => p.test(msg))) return 'too_many_in_flight';

  // Provider/transport rate limits and transient failures.
  if (RATE_LIMIT_PATTERNS.some((p) => p.test(msg))) return 'rate_limit';

  return 'generic';
}

/**
 * Get a user-friendly error message based on error content.
 */
export function getAIErrorMessage(errorMessage: string | undefined): string {
  switch (classifyAIError(errorMessage)) {
    case 'auth':
      return 'Authentication failed. Please refresh the page and try again.';
    case 'out_of_credits':
      return "You've used up your AI credits. Buy more credits or wait for your monthly allowance to reset.";
    case 'too_many_in_flight':
      return 'Too many AI requests are running at once. Wait for one to finish, then try again.';
    case 'rate_limit':
      return 'The AI service is busy right now. Please try again in a few seconds.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

/**
 * Check if error is an authentication error.
 */
export function isAuthenticationError(errorMessage: string | undefined): boolean {
  return classifyAIError(errorMessage) === 'auth';
}

/**
 * Check if the AI request was denied because the user is out of prepaid credits (402).
 * Used to surface a "Buy credits" call to action.
 */
export function isOutOfCreditsError(errorMessage: string | undefined): boolean {
  return classifyAIError(errorMessage) === 'out_of_credits';
}

/**
 * Check if the AI request was denied by the free-tier in-flight concurrency cap (429).
 */
export function isInFlightCapError(errorMessage: string | undefined): boolean {
  return classifyAIError(errorMessage) === 'too_many_in_flight';
}

/**
 * Check if error is a rate-limit / busy / out-of-credits / in-flight error — i.e. a
 * denial the user can recover from by waiting or buying credits, not a hard failure.
 */
export function isRateLimitError(errorMessage: string | undefined): boolean {
  const kind = classifyAIError(errorMessage);
  return kind === 'rate_limit' || kind === 'out_of_credits' || kind === 'too_many_in_flight';
}
