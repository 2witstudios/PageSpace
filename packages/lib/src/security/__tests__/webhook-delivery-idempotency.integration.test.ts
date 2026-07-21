/**
 * Webhook Delivery Idempotency Integration Tests
 *
 * Exercises the REAL SQL semantics of the claim/complete/release lifecycle
 * against Postgres — the atomic upsert's CASE arms (pending count, completed
 * sentinel, expired-lease reclaim) and the count-guarded release, none of
 * which the unit tests' chainable db mocks can execute. Skips gracefully when
 * the DB is unavailable (same pattern as distributed-rate-limit.integration).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { db } from '@pagespace/db/db';
import { sql, eq, and } from '@pagespace/db/operators';
import { rateLimitBuckets } from '@pagespace/db/schema/rate-limit-buckets';
import {
  claimWebhookDelivery,
  completeWebhookDelivery,
  releaseWebhookDelivery,
} from '../webhook-delivery-idempotency';

let dbAvailable = false;
// Unique webhook-id prefix so cleanup can't touch real rows; the module
// namespaces keys as `webhook-seen:{webhookId}:{deliveryId}`.
const TEST_WEBHOOK_PREFIX = 'itest-whidem-';
const KEY_LIKE = `webhook-seen:${TEST_WEBHOOK_PREFIX}%`;

const SEEN_WINDOW_START = new Date(0);

beforeAll(async () => {
  try {
    await db.execute(sql`SELECT 1`);
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

beforeEach(async () => {
  if (dbAvailable) {
    await db.delete(rateLimitBuckets).where(sql`${rateLimitBuckets.key} LIKE ${KEY_LIKE}`);
  }
});

let seq = 0;
function freshIds(): { webhookId: string; deliveryId: string } {
  seq += 1;
  return { webhookId: `${TEST_WEBHOOK_PREFIX}${Date.now()}-${seq}`, deliveryId: `d-${seq}` };
}

async function readRow(webhookId: string, deliveryId: string) {
  const rows = await db
    .select({ count: rateLimitBuckets.count, expiresAt: rateLimitBuckets.expiresAt })
    .from(rateLimitBuckets)
    .where(
      and(
        eq(rateLimitBuckets.key, `webhook-seen:${webhookId}:${deliveryId}`),
        eq(rateLimitBuckets.windowStart, SEEN_WINDOW_START)
      )
    )
    .limit(1);
  return rows[0];
}

describe('webhook delivery idempotency (Postgres)', () => {
  it('walks the full lifecycle: claimed -> pending (in flight) -> completed -> duplicate', async () => {
    if (!dbAvailable) return;
    const { webhookId, deliveryId } = freshIds();

    await expect(claimWebhookDelivery(webhookId, deliveryId)).resolves.toBe('claimed');
    // Identical request while the first is in flight.
    await expect(claimWebhookDelivery(webhookId, deliveryId)).resolves.toBe('pending');

    await completeWebhookDelivery(webhookId, deliveryId);
    // From completion on, identical requests are duplicates — repeatedly.
    await expect(claimWebhookDelivery(webhookId, deliveryId)).resolves.toBe('duplicate');
    await expect(claimWebhookDelivery(webhookId, deliveryId)).resolves.toBe('duplicate');
  });

  it('release frees a PENDING claim so a retry claims fresh', async () => {
    if (!dbAvailable) return;
    const { webhookId, deliveryId } = freshIds();

    await expect(claimWebhookDelivery(webhookId, deliveryId)).resolves.toBe('claimed');
    await releaseWebhookDelivery(webhookId, deliveryId);
    await expect(claimWebhookDelivery(webhookId, deliveryId)).resolves.toBe('claimed');
  });

  it('release does NOT delete a COMPLETED marker — a late release from a racing attempt cannot re-open committed work', async () => {
    if (!dbAvailable) return;
    const { webhookId, deliveryId } = freshIds();

    await claimWebhookDelivery(webhookId, deliveryId);
    await completeWebhookDelivery(webhookId, deliveryId);
    await releaseWebhookDelivery(webhookId, deliveryId);

    await expect(claimWebhookDelivery(webhookId, deliveryId)).resolves.toBe('duplicate');
  });

  it('reclaims an ABANDONED pending claim once its lease lapses (crashed process never released)', async () => {
    if (!dbAvailable) return;
    const { webhookId, deliveryId } = freshIds();

    await expect(claimWebhookDelivery(webhookId, deliveryId)).resolves.toBe('claimed');
    // Simulate the lease lapsing without waiting 60s: age the row in place.
    await db
      .update(rateLimitBuckets)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        and(
          eq(rateLimitBuckets.key, `webhook-seen:${webhookId}:${deliveryId}`),
          eq(rateLimitBuckets.windowStart, SEEN_WINDOW_START)
        )
      );

    // The sender's retry claims fresh instead of being walled off behind 409s.
    await expect(claimWebhookDelivery(webhookId, deliveryId)).resolves.toBe('claimed');
    // And the reclaim re-armed a live lease: a follow-up contender is pending.
    await expect(claimWebhookDelivery(webhookId, deliveryId)).resolves.toBe('pending');
  });

  it('completion extends the record from the short pending lease to the full dedup TTL', async () => {
    if (!dbAvailable) return;
    const { webhookId, deliveryId } = freshIds();

    await claimWebhookDelivery(webhookId, deliveryId);
    const pendingRow = await readRow(webhookId, deliveryId);
    await completeWebhookDelivery(webhookId, deliveryId);
    const completedRow = await readRow(webhookId, deliveryId);

    expect(pendingRow).toBeDefined();
    expect(completedRow).toBeDefined();
    // Pending lease is short (about a minute); completed TTL covers 2x the
    // 5-minute signature window.
    expect(pendingRow!.expiresAt.getTime() - Date.now()).toBeLessThan(2 * 60 * 1000);
    expect(completedRow!.expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    expect(completedRow!.count).toBeGreaterThan(1_000_000);
  });

  it('completing a key that holds no claim is a harmless no-op (no completed marker conjured from nothing)', async () => {
    if (!dbAvailable) return;
    const { webhookId, deliveryId } = freshIds();

    await completeWebhookDelivery(webhookId, deliveryId);
    await expect(readRow(webhookId, deliveryId)).resolves.toBeUndefined();
    // The id is still claimable as a first delivery.
    await expect(claimWebhookDelivery(webhookId, deliveryId)).resolves.toBe('claimed');
  });
});
