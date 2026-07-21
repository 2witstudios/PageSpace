import { createHash } from 'crypto';
import { db } from '@pagespace/db/db';
import { sql, eq, and } from '@pagespace/db/operators';
import { rateLimitBuckets } from '@pagespace/db/schema/rate-limit-buckets';
import { loggers } from '../logging/logger-config';
import { DEFAULT_REPLAY_WINDOW_MS } from './webhook-signature';

/**
 * Webhook delivery idempotency (audit F4) — the seen-id store that closes the
 * replay gap the signature scheme leaves open. The ±5-minute timestamp window
 * in webhook-signature.ts bounds HOW LONG a captured signed request stays
 * valid, but nothing stops it being replayed unlimited times inside that
 * window — each replay re-posting the channel message and re-firing every
 * bound workflow. This module makes one signed delivery process exactly once.
 *
 * Delivery identity is derived EXCLUSIVELY from the signed material (the
 * timestamp+signature pair, unique per signed request): byte-identical
 * replays and retries dedup; a re-signed retry (fresh timestamp) counts as a
 * new delivery, which is exactly the at-least-once contract senders already
 * have. A client-supplied delivery-id header is deliberately NOT part of the
 * identity: the v0 HMAC covers only timestamp+body, so such a header would be
 * unauthenticated — honoring it would let an attacker replay a captured
 * request under a fresh id each time (bypassing dedup), and compounding it
 * with the signature id would let an attacker pre-claim a predicted future id
 * and suppress a legitimate delivery. A future signature scheme that signs a
 * delivery id could restore cross-signature dedup safely.
 *
 * Claim lifecycle: claim-on-arrival, then complete-on-acceptance or
 * release-on-failure.
 * - `claimWebhookDelivery` atomically claims the id (`INSERT ... ON CONFLICT
 *   DO UPDATE count+1 RETURNING count` on the shared rate_limit_buckets
 *   store, so concurrent replays serialize on the row lock and exactly one
 *   wins). 'claimed' → proceed; 'pending' → an identical delivery is still
 *   in flight (callers must answer RETRYABLE, never a success — the in-flight
 *   attempt may yet fail and release); 'duplicate' → an identical delivery
 *   already COMPLETED, safe to acknowledge as a no-op success.
 * - `completeWebhookDelivery` marks the claim completed once the delivery is
 *   accepted, flipping future claims from 'pending' to 'duplicate'.
 * - `releaseWebhookDelivery` frees the claim on every non-accepted outcome so
 *   a sender retry after a retryable failure still delivers (sender retries
 *   are the design's at-least-once mechanism — see the intake route).
 *
 * Fail-open by design: if the store is unreachable the claim reports
 * 'claimed' and delivery proceeds — the signature + window still gate, and a
 * store outage already fails the delivery downstream as a retryable 5xx, so
 * failing closed here would only convert a DB blip into silently swallowed
 * deliveries (a 2xx duplicate the sender never retries).
 */

// Seen ids must outlive the signature replay window or a captured request
// could replay after the claim expires but before its timestamp goes stale.
// 2x the window closes the gap with margin; rows are swept with the rest of
// rate_limit_buckets, so an id may dedup somewhat longer than the TTL — fine,
// since the identity is unique per signed request.
const SEEN_TTL_MS = 2 * DEFAULT_REPLAY_WINDOW_MS;

// All seen rows share one constant window_start so the (key, window_start)
// primary key makes the key alone the effective conflict target.
const SEEN_WINDOW_START = new Date(0);

// A completed claim is encoded in the row's count: completion sets it to this
// sentinel, so the atomic claim upsert can distinguish 'pending' (small
// counts: the first attempt is still in flight) from 'duplicate' (count above
// the sentinel: an attempt already completed) in one round-trip. Pending
// counts can never legitimately reach the sentinel — that would take a
// million in-flight replays of one signed request inside a 10-minute TTL,
// orders of magnitude beyond the per-webhook rate limit.
const COMPLETED_SENTINEL_COUNT = 1_000_000;

export type WebhookDeliveryClaim = 'claimed' | 'pending' | 'duplicate';

/**
 * Derive the delivery id for a VERIFIED request from its signed material.
 * Only ever call with the signature/timestamp that passed verification.
 * Hashing keeps store keys constant-size.
 */
export function deriveWebhookDeliveryId(input: { signature: string; timestamp: string }): string {
  return createHash('sha256')
    .update(`signature:${input.timestamp}:${input.signature}`)
    .digest('hex');
}

function seenKey(webhookId: string, deliveryId: string): string {
  return `webhook-seen:${webhookId}:${deliveryId}`;
}

/**
 * Atomically claim a delivery id. 'claimed' means this request is the first
 * (or the store was unreachable — see fail-open note above) and must proceed;
 * 'pending' means an identical delivery is still in flight and the caller
 * must answer retryable; 'duplicate' means an identical delivery already
 * completed and the caller must short-circuit without re-dispatching.
 */
export async function claimWebhookDelivery(
  webhookId: string,
  deliveryId: string
): Promise<WebhookDeliveryClaim> {
  try {
    const rows = await db
      .insert(rateLimitBuckets)
      .values({
        key: seenKey(webhookId, deliveryId),
        windowStart: SEEN_WINDOW_START,
        count: 1,
        expiresAt: new Date(Date.now() + SEEN_TTL_MS),
      })
      .onConflictDoUpdate({
        target: [rateLimitBuckets.key, rateLimitBuckets.windowStart],
        set: { count: sql`${rateLimitBuckets.count} + 1` },
      })
      .returning({ count: rateLimitBuckets.count });
    const count = rows[0]?.count ?? 1;
    if (count === 1) return 'claimed';
    return count > COMPLETED_SENTINEL_COUNT ? 'duplicate' : 'pending';
  } catch (error) {
    loggers.api.warn('Webhook delivery idempotency claim failed — proceeding without dedup', {
      webhookId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'claimed';
  }
}

/**
 * Mark a claimed delivery completed once it has been ACCEPTED, so identical
 * requests from now on read 'duplicate' instead of 'pending'. Best-effort and
 * never throws: if the store is unreachable the claim stays pending, which
 * keeps replays answering retryable — never a double delivery — until the
 * claim's TTL expires.
 */
export async function completeWebhookDelivery(webhookId: string, deliveryId: string): Promise<void> {
  try {
    await db
      .update(rateLimitBuckets)
      .set({ count: COMPLETED_SENTINEL_COUNT })
      .where(
        and(
          eq(rateLimitBuckets.key, seenKey(webhookId, deliveryId)),
          eq(rateLimitBuckets.windowStart, SEEN_WINDOW_START)
        )
      );
  } catch (error) {
    loggers.api.warn('Webhook delivery idempotency completion failed — claim stays pending', {
      webhookId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Release a claim after a non-accepted delivery outcome so the sender's retry
 * of the same delivery id is not swallowed as a duplicate. Best-effort and
 * never throws: an unreleased claim self-expires with the TTL.
 */
export async function releaseWebhookDelivery(webhookId: string, deliveryId: string): Promise<void> {
  try {
    await db
      .delete(rateLimitBuckets)
      .where(
        and(
          eq(rateLimitBuckets.key, seenKey(webhookId, deliveryId)),
          eq(rateLimitBuckets.windowStart, SEEN_WINDOW_START)
        )
      );
  } catch (error) {
    loggers.api.warn('Webhook delivery idempotency release failed — claim will expire with its TTL', {
      webhookId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
