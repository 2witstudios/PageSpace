import { NextResponse } from 'next/server';
import type { GateResult } from '@pagespace/lib/billing/credit-core';

/**
 * Map a denied credit-gate result to the HTTP error the AI routes return. Two
 * distinct denials, surfaced as different statuses so the client can tell them
 * apart:
 *   - too_many_in_flight -> 429: the free-tier concurrency cap (too many AI calls
 *     running at once); the user should wait for one to finish, not buy credits.
 *   - daily_cap_exceeded -> 429: the per-user/day exposure backstop; the user has hit
 *     their daily spend ceiling and should retry tomorrow, not buy credits.
 *   - everything else (out_of_credits / needs_init) -> 402: the prepaid balance is
 *     exhausted; the user must add credits or wait for the monthly reset.
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
    message: 'Your AI credit balance is too low. Add credits to get back to positive, or wait for your monthly allowance to reset.',
  };
}

/** Convenience: the standard JSON response for a denied gate result. */
export function creditGateErrorResponse(reason: GateResult['reason']): NextResponse {
  const { status, error, message } = creditGatePayload(reason);
  return NextResponse.json({ error, message }, { status });
}
