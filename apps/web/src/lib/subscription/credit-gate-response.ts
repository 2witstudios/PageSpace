import { NextResponse } from 'next/server';
import type { GateResult } from '@pagespace/lib/billing/credit-core';
import { buildServerMetadata } from '@pagespace/lib/auth/oauth/metadata';
import type { SpendRefusal } from '@pagespace/lib/billing/credit-gate';

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
 * WAL-2: a seat refused by the member's monthly allowance is not a source that "cannot cover"
 * the call — the org pool may be full. Say what ran out.
 */
const SEAT_CAP_REACHED_MESSAGE = "You've reached the limit of your seat allowance. Choose another source to continue.";

/**
 * Convenience: the standard JSON response for a denied gate result. A refused source
 * (SPEND-4) also carries the refused source, why, and the sources the person may pick;
 * an unclaimed agent's requires_funding carries its claim_url (ADR 0007 Decision 9).
 */
export function creditGateErrorResponse(reason: GateResult['reason'], refusal?: SpendRefusal): NextResponse {
  const payload = creditGatePayload(reason);
  const { status, error, claim_url } = payload;
  const message = refusal?.reason === 'source_cap_reached' ? SEAT_CAP_REACHED_MESSAGE : payload.message;
  return NextResponse.json(
    refusal
      ? { error, message, source: refusal.source, refusalReason: refusal.reason, options: refusal.options }
      : claim_url === undefined
        ? { error, message }
        : { error, message, claim_url },
    { status },
  );
}
