import { NextResponse } from 'next/server';
import type { GateResult } from '@pagespace/lib/billing/credit-core';
import type { SpendRefusal } from '@pagespace/lib/billing/credit-gate';

/**
 * Map a denied credit-gate result to the HTTP error the AI routes return. Two
 * distinct denials, surfaced as different statuses so the client can tell them
 * apart:
 *   - too_many_in_flight -> 429: the free-tier concurrency cap (too many AI calls
 *     running at once); the user should wait for one to finish, not buy credits.
 *   - daily_cap_exceeded -> 429: the per-user/day exposure backstop; the user has hit
 *     their daily spend ceiling and should retry tomorrow, not buy credits.
 *   - everything else (out_of_credits / needs_init) -> 402: the prepaid balance is
 *     exhausted; the user must add credits, upgrade, or (paid tiers) wait for the
 *     next monthly renewal. The free starter grant never renews.
 */
export function creditGatePayload(reason: GateResult['reason']): {
  status: number;
  error: string;
  message: string;
} {
  if (reason === 'too_many_in_flight') {
    return {
      status: 429,
      error: 'too_many_in_flight',
      message: 'Too many AI requests in flight at once. Wait for one to finish, then try again.',
    };
  }
  if (reason === 'source_refused') {
    // SPEND-4: the source the call named cannot pay (empty, paused, not this person's to
    // spend, or none named where several exist). Nothing was reserved or charged, and the
    // gate did not switch wallets; the body names the source and the other options.
    return {
      status: 402,
      error: 'spend_source_refused',
      message: 'The credit source for this request cannot cover it. Choose another source to continue.',
    };
  }
  if (reason === 'daily_cap_exceeded') {
    return {
      status: 429,
      error: 'daily_cap_exceeded',
      message: 'You\'ve reached your daily AI usage limit. Try again tomorrow.',
    };
  }
  return {
    status: 402,
    error: 'out_of_credits',
    message: 'Your credit balance is too low to run this request. On a paid plan, your monthly allowance is added at your next renewal.',
  };
}

/**
 * Convenience: the standard JSON response for a denied gate result. A refused source
 * (SPEND-4) also carries the refused source, why, and the sources the person may pick.
 */
export function creditGateErrorResponse(reason: GateResult['reason'], refusal?: SpendRefusal): NextResponse {
  const { status, error, message } = creditGatePayload(reason);
  return NextResponse.json(
    refusal
      ? { error, message, source: refusal.source, refusalReason: refusal.reason, options: refusal.options }
      : { error, message },
    { status },
  );
}
