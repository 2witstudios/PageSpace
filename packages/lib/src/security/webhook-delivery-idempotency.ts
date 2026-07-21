import { createHash } from 'crypto';
import { db } from '@pagespace/db/db';
import { sql, eq, and, lt } from '@pagespace/db/operators';
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
 * and suppress a legitimate delivery. Known consequence: two DISTINCT events
 * whose bodies are byte-identical and signed within the same second produce
 * the same signature and therefore the same identity — the second acks as a
 * duplicate. That collapse is indistinguishable from a retry at the protocol
 * level (v0 signs no nonce); senders emitting identical bodies at sub-second
 * rates must include a distinguishing field (an event id, a timestamp) in the
 * payload. A future signature scheme that signs a delivery id could restore
 * cross-signature dedup and lift this limit safely.
 *
 * Claim lifecycle: claim-on-arrival, then complete-on-acceptance or
 * release-on-failure.
 * - `claimWebhookDelivery` atomically claims the id (`INSERT ... ON CONFLICT
 *   DO UPDATE ... RETURNING count` on the shared rate_limit_buckets store, so
 *   concurrent replays serialize on the row lock and exactly one wins).
 *   'claimed' → proceed; 'pending' → an identical delivery is still in
 *   flight (callers must answer RETRYABLE, never a success — the in-flight
 *   attempt may yet fail and release); 'duplicate' → an identical delivery
 *   already COMPLETED, safe to acknowledge as a no-op success.
 * - A pending claim carries a short LEASE (`expiresAt`), not the full dedup
 *   TTL: if the claiming process dies mid-delivery (crash, deploy, OOM) and
 *   never releases, the claim becomes reclaimable once the lease lapses, so a
 *   sender retry delivers instead of being walled off behind 409s for the
 *   rest of the signature window. The lease comfortably exceeds a worst-case
 *   in-request delivery (the pre-response work is db lookups + a channel
 *   insert; AI fan-out happens after the response).
 * - `completeWebhookDelivery` marks the claim completed once the delivery is
 *   accepted — flipping future claims from 'pending' to 'duplicate' — and
 *   extends the row to the full dedup TTL. If the row is already gone (only
 *   possible ≥ the dedup TTL after claiming, far past signature staleness)
 *   the UPDATE is a harmless no-op.
 * - `releaseWebhookDelivery` frees the claim on every non-accepted outcome so
 *   a sender retry after a retryable failure still delivers (sender retries
 *   are the design's at-least-once mechanism — see the intake route). It
 *   only ever deletes PENDING claims: a completed marker must survive, or a
 *   late failure from a racing attempt could erase the dedup record and let
 *   a replay re-deliver committed work.
 *
 * Fail-open by design: if the store is unreachable the claim reports
 * 'claimed' and delivery proceeds — the signature + window still gate, and a
 * store outage already fails the delivery downstream as a retryable 5xx
 * (dispatch and the claim store share the same Postgres, and dispatch's rate
 * limit fails CLOSED in production), so failing closed here would only
 * convert a DB blip into silently swallowed deliveries (a 2xx duplicate the
 * sender never retries).
 */

// How long a PENDING claim is honored before it is considered abandoned and
// becomes reclaimable. Must exceed any legitimate in-flight delivery (seconds)
// by a wide margin, and stay well under the 5-minute signature window so a
// sender retrying an orphaned delivery still lands inside it.
const PENDING_CLAIM_LEASE_MS = 60 * 1000;

// How long a COMPLETED claim dedups. Must outlive the signature replay window
// or a captured request could replay after the record expires but before its
// timestamp goes stale. 2x the window closes the gap with margin; rows are
// swept with the rest of rate_limit_buckets, so an id may dedup somewhat
// longer than the TTL — harmless over-dedup of a by-then-stale signature.
const COMPLETED_TTL_MS = 2 * DEFAULT_REPLAY_WINDOW_MS;

// All seen rows share one constant window_start so the (key, window_start)
// primary key makes the key alone the effective conflict target.
const SEEN_WINDOW_START = new Date(0);

// A completed claim is encoded in the row's count: completion sets it to this
// sentinel, so the atomic claim upsert can distinguish 'pending' (small
// counts) from 'duplicate' (count at/above the sentinel) in one round-trip.
// The gap below the sentinel is bounded only by how many identical requests
// infrastructure can land while one is in flight (the per-webhook rate limit
// runs inside dispatch, AFTER this check, so it does not bound the claim
// path) — 2^30 leaves that many orders of magnitude beyond any real flood
// while still fitting int4 with headroom for post-completion increments.
const COMPLETED_SENTINEL_COUNT = 2 ** 30;

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
 * Atomically claim a delivery id. 'claimed' means this request is the first —
 * or the previous pending claim's lease lapsed (abandoned by a dead process),
 * or the store was unreachable (see fail-open note above) — and must proceed;
 * 'pending' means an identical delivery is still in flight and the caller
 * must answer retryable; 'duplicate' means an identical delivery already
 * completed and the caller must short-circuit without re-dispatching.
 */
export async function claimWebhookDelivery(
  webhookId: string,
  deliveryId: string
): Promise<WebhookDeliveryClaim> {
  try {
    const now = new Date();
    const pendingLeaseExpiry = new Date(now.getTime() + PENDING_CLAIM_LEASE_MS);
    // The CASE arms read the OLD row (Postgres exposes it under the table
    // name in ON CONFLICT DO UPDATE): a completed row keeps counting
    // duplicates regardless of expiry (over-dedup of a stale signature is
    // harmless); an expired pending row is reclaimed as if fresh; a live
    // pending row just counts the contender. Comparisons use the app clock
    // (`now`) on both sides so lease math never mixes app and DB clocks.
    const rows = await db
      .insert(rateLimitBuckets)
      .values({
        key: seenKey(webhookId, deliveryId),
        windowStart: SEEN_WINDOW_START,
        count: 1,
        expiresAt: pendingLeaseExpiry,
      })
      .onConflictDoUpdate({
        target: [rateLimitBuckets.key, rateLimitBuckets.windowStart],
        set: {
          count: sql`CASE
            WHEN ${rateLimitBuckets.count} >= ${COMPLETED_SENTINEL_COUNT} THEN ${rateLimitBuckets.count} + 1
            WHEN ${rateLimitBuckets.expiresAt} <= ${now} THEN 1
            ELSE ${rateLimitBuckets.count} + 1
          END`,
          expiresAt: sql`CASE
            WHEN ${rateLimitBuckets.count} >= ${COMPLETED_SENTINEL_COUNT} THEN ${rateLimitBuckets.expiresAt}
            WHEN ${rateLimitBuckets.expiresAt} <= ${now} THEN ${pendingLeaseExpiry}
            ELSE ${rateLimitBuckets.expiresAt}
          END`,
        },
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
 * requests from now on read 'duplicate' instead of 'pending', and extend the
 * record from the short pending lease to the full dedup TTL. Best-effort and
 * never throws: if the store is unreachable the claim stays pending, which
 * keeps replays answering retryable — never a double delivery — until the
 * pending lease lapses.
 */
export async function completeWebhookDelivery(webhookId: string, deliveryId: string): Promise<void> {
  try {
    await db
      .update(rateLimitBuckets)
      .set({
        count: COMPLETED_SENTINEL_COUNT,
        expiresAt: new Date(Date.now() + COMPLETED_TTL_MS),
      })
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
 * Release a PENDING claim after a non-accepted delivery outcome so the
 * sender's retry of the same delivery id is not swallowed. The count guard
 * makes completed markers un-deletable — releasing one would let a replay
 * re-deliver committed work. Best-effort and never throws: an unreleased
 * pending claim self-expires with its lease.
 */
export async function releaseWebhookDelivery(webhookId: string, deliveryId: string): Promise<void> {
  try {
    await db
      .delete(rateLimitBuckets)
      .where(
        and(
          eq(rateLimitBuckets.key, seenKey(webhookId, deliveryId)),
          eq(rateLimitBuckets.windowStart, SEEN_WINDOW_START),
          lt(rateLimitBuckets.count, COMPLETED_SENTINEL_COUNT)
        )
      );
  } catch (error) {
    loggers.api.warn('Webhook delivery idempotency release failed — claim will expire with its lease', {
      webhookId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
