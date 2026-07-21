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
 * Delivery identity: the sender MAY send an `x-pagespace-delivery-id` header,
 * unique per logical delivery — retries (including re-signed retries with a
 * fresh timestamp) reuse the same id and dedup. Without the header, identity
 * falls back to a hash of the signature+timestamp pair, which is unique per
 * signed request: byte-identical retries dedup, while a re-signed retry counts
 * as a new delivery (at-least-once, exactly what a header-less sender expects).
 *
 * Claim semantics: `claimWebhookDelivery` is an atomic claim-on-arrival —
 * `INSERT ... ON CONFLICT DO UPDATE count+1 RETURNING count` on the shared
 * rate_limit_buckets store, so concurrent replays serialize on the row lock
 * and exactly one wins. Because the claim lands BEFORE the delivery outcome is
 * known, every non-accepted outcome must `releaseWebhookDelivery` so a sender
 * retry after a retryable failure still delivers (the design's at-least-once
 * mechanism is sender retries — see the intake route).
 *
 * Fail-open by design: if the store is unreachable the claim reports
 * 'claimed' and delivery proceeds — the signature + window still gate, and a
 * store outage already fails the delivery downstream as a retryable 5xx, so
 * failing closed here would only convert a DB blip into silently swallowed
 * deliveries (a 2xx duplicate the sender never retries).
 */

/** Optional sender-supplied delivery id header — unique per logical delivery. */
export const WEBHOOK_DELIVERY_ID_HEADER = 'x-pagespace-delivery-id';

// Seen ids must outlive the signature replay window or a captured request
// could replay after the claim expires but before its timestamp goes stale.
// 2x the window closes the gap with margin; rows are swept with the rest of
// rate_limit_buckets, so an id may dedup somewhat longer than the TTL — fine,
// since delivery ids are unique per delivery by contract.
const SEEN_TTL_MS = 2 * DEFAULT_REPLAY_WINDOW_MS;

// All seen rows share one constant window_start so the (key, window_start)
// primary key makes the key alone the effective conflict target.
const SEEN_WINDOW_START = new Date(0);

/**
 * Derive the delivery id for a VERIFIED request. Only ever call with the
 * signature/timestamp that passed verification — deriving from unverified
 * headers would let an attacker pre-poison a genuine delivery's id.
 * Hashing (rather than using raw values) keeps store keys constant-size and
 * neutralizes arbitrary header bytes.
 */
export function deriveWebhookDeliveryId(input: {
  headerValue: string | null;
  signature: string;
  timestamp: string;
}): string {
  const clientId = input.headerValue?.trim();
  const source = clientId
    ? `header:${clientId}`
    : `signature:${input.timestamp}:${input.signature}`;
  return createHash('sha256').update(source).digest('hex');
}

function seenKey(webhookId: string, deliveryId: string): string {
  return `webhook-seen:${webhookId}:${deliveryId}`;
}

/**
 * Atomically claim a delivery id. 'claimed' means this request is the first
 * (or the store was unreachable — see fail-open note above) and must proceed;
 * 'duplicate' means an earlier request already claimed it and the caller must
 * short-circuit without re-dispatching anything.
 */
export async function claimWebhookDelivery(
  webhookId: string,
  deliveryId: string
): Promise<'claimed' | 'duplicate'> {
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
    return (rows[0]?.count ?? 1) > 1 ? 'duplicate' : 'claimed';
  } catch (error) {
    loggers.api.warn('Webhook delivery idempotency claim failed — proceeding without dedup', {
      webhookId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'claimed';
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
