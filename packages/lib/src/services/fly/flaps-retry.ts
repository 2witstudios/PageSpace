/**
 * flaps-retry — the PURE retry/backoff decision layer for Flaps calls.
 *
 * INVARIANT: this module has zero I/O. No fetch, no db, no env, no clock, no
 * timers. Every input is an explicit argument; every output is a value. The
 * flaps client is the thin loop that executes these decisions — same split as
 * credit-core/credit-consume, and the same shape as sprites.ts's
 * planWakeRetry/withWakeRetry pair. The purity invariant is enforced by a test.
 *
 * Fly's Machines API rate-limits PER OBJECT: roughly 1 request/second sustained
 * per app, with a burst of 3. That is generous across apps (parallel provisioning
 * of DIFFERENT apps scales fine) and tight within one, so the backoff here is
 * about not hammering a single app rather than about global throughput.
 */

/** Bounded attempts. A Flaps call that fails three times is reported, not retried forever. */
export const MAX_FLAPS_ATTEMPTS = 3;

/** Fly's per-object sustained rate is ~1 r/s, so a 1s base is the natural floor. */
export const FLAPS_RETRY_BASE_DELAY_MS = 1_000;

/** Never sleep longer than this on a `Retry-After`, however large the header claims. */
export const FLAPS_MAX_RETRY_DELAY_MS = 30_000;

export type FlapsRetryPlan = { retry: true; delayMs: number } | { retry: false };

/**
 * Linear backoff (attempt is 1-based): 1s, 2s, 3s. Linear rather than exponential
 * because the limit being respected is a steady per-second rate, not a contended
 * global resource — exponential would just idle longer than the bucket needs.
 */
export function flapsRetryDelayMs(
  attempt: number,
  baseDelayMs: number = FLAPS_RETRY_BASE_DELAY_MS,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(baseDelayMs * safeAttempt, FLAPS_MAX_RETRY_DELAY_MS);
}

/**
 * Parse a `Retry-After` header value into milliseconds.
 *
 * Fly sends the delta-seconds form. The HTTP-date form is accepted too but is
 * deliberately NOT resolved against a clock here — this module is pure, and a
 * caller-supplied clock would be one more thing to get wrong for a header Fly does
 * not send. An unparseable, negative, or absent value yields null, meaning "no
 * server-specified delay; use the backoff schedule".
 */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(Math.round(seconds * 1000), FLAPS_MAX_RETRY_DELAY_MS);
}

/**
 * Decide whether a failed Flaps call should be retried, and after how long.
 *
 * Retryable: 429 (rate limited — this is the expected one) and 5xx (Fly-side
 * transient). NOT retryable: any 4xx other than 429, because a 401/403/404/422 is
 * a statement about our request that will be equally true next second. Retrying an
 * auth failure just turns one clear error into three slow ones.
 *
 * A server-specified `Retry-After` always wins over our schedule — it is Fly
 * telling us exactly when its bucket refills.
 */
export function planFlapsRetry({
  status,
  retryAfterMs = null,
  attempt,
  idempotent = true,
  maxAttempts = MAX_FLAPS_ATTEMPTS,
  baseDelayMs = FLAPS_RETRY_BASE_DELAY_MS,
}: {
  /** HTTP status, or null for a transport-level failure (DNS, socket, timeout). */
  status: number | null;
  retryAfterMs?: number | null;
  attempt: number;
  /**
   * Whether re-sending this exact request is harmless.
   *
   * FALSE NARROWS THE RETRY SET TO 429 ALONE, and the reason is that a failure can
   * be AMBIGUOUS rather than clean. A socket error or a 5xx says nothing about
   * whether Fly processed the request before the answer was lost — so retrying a
   * machine create can bill a second machine, and retrying a deploy-token mint can
   * issue a second self-renewing credential that is never returned to anyone and
   * appears in no audit row. A 429 is the one failure Fly states it did NOT
   * process, which is why it stays retryable for every request.
   */
  idempotent?: boolean;
  maxAttempts?: number;
  baseDelayMs?: number;
}): FlapsRetryPlan {
  if (attempt >= maxAttempts) return { retry: false };

  // A transport failure never reached Fly *if it never reached Fly* — which is
  // precisely what cannot be known from this side. For an idempotent request that
  // ambiguity is harmless and a retry is right; for a mutating one it is the whole
  // problem, so only the unambiguous 429 survives.
  const retryable = idempotent
    ? status === null || status === 429 || status >= 500
    : status === 429;
  if (!retryable) return { retry: false };

  const delayMs = retryAfterMs ?? flapsRetryDelayMs(attempt, baseDelayMs);
  return { retry: true, delayMs: Math.min(delayMs, FLAPS_MAX_RETRY_DELAY_MS) };
}
