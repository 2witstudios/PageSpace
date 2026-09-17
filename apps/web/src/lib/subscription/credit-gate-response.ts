import { NextResponse } from 'next/server';
import type { GateResult } from '@pagespace/lib/billing/credit-core';
import { buildServerMetadata } from '@pagespace/lib/auth/oauth/metadata';

/**
 * Map a denied credit-gate result to the HTTP error the AI routes return. Two
 * distinct denials, surfaced as different statuses so the client can tell them
 * apart:
 *   - too_many_in_flight -> 429: the free-tier concurrency cap (too many AI calls
 *     running at once); the user should wait for one to finish, not buy credits.
 *   - daily_cap_exceeded -> 429: the per-user/day exposure backstop; the user has hit
 *     their daily spend ceiling and should retry tomorrow, not buy credits.
 *   - requires_funding -> 402 + claim_url: an UNCLAIMED agent has no credits and no
 *     way to buy any (ADR 0007 Decision 9); only a human claiming it funds it, so the
 *     body points at the claim endpoint and /auth.md instead of "add credits".
 *   - everything else (out_of_credits / needs_init) -> 402: the prepaid balance is
 *     exhausted; the user must add credits, upgrade, or (paid tiers) wait for the
 *     next monthly renewal. The free starter grant never renews.
 */
export function creditGatePayload(reason: GateResult['reason']): {
  status: number;
  error: string;
  message: string;
  claim_url?: string;
} {
  if (reason === 'requires_funding') {
    // Same issuer source as the RFC 8414 metadata route, so claim_url is always
    // the claim_endpoint that document advertises.
    const issuer = process.env.WEB_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? '';
    const metadata = buildServerMetadata({ issuer });
    return {
      status: 402,
      error: 'requires_funding',
      message: `Agent accounts receive no free AI credits. Ask a human to claim you: POST your claim_token to claim_url and give them the verification link it returns; they pay for your AI usage from then on. Full steps: ${metadata.agent_auth.skill}`,
      claim_url: metadata.agent_auth.claim_endpoint,
    };
  }
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
    message: 'Your credit balance is too low. Add credits to get back to positive, or upgrade your plan. On a paid plan, your monthly allowance is also added at your next renewal.',
  };
}

/** Convenience: the standard JSON response for a denied gate result. */
export function creditGateErrorResponse(reason: GateResult['reason']): NextResponse {
  const { status, error, message, claim_url } = creditGatePayload(reason);
  return NextResponse.json(claim_url === undefined ? { error, message } : { error, message, claim_url }, { status });
}
