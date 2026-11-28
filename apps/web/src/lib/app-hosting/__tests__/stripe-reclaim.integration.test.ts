/**
 * The Stripe reclaim drain against a real Postgres (Spec WAL-9, D-OW-64): a period-end release
 * that is upgraded to an immediate cancel WHILE the drain is talking to Stripe (the app was
 * destroyed meanwhile) is never discarded. The drain's delete compares the mode it acted on, so it
 * misses, re-reads the row, and cancels immediately.
 *
 * REAL: the outbox table, the compare-and-delete and the re-read. Faked: Stripe, whose period-end
 * call performs the concurrent upgrade (exactly what destroyPublishedApp's upsert writes).
 *
 * Requires DATABASE_URL → a migrated Postgres. Deletes every row it creates.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { appHostingStripeReclaims } from '@pagespace/db/schema/app-hosting-stripe-reclaims';
import { ensureTestDb } from '@/test/ensure-test-db';

const { mockUpdate, mockCancel } = vi.hoisted(() => ({ mockUpdate: vi.fn(), mockCancel: vi.fn() }));
vi.mock('@/lib/stripe', () => ({
  stripe: { subscriptions: { update: mockUpdate, cancel: mockCancel } },
  Stripe: { errors: { StripeInvalidRequestError: class StripeInvalidRequestError extends Error {} } },
}));

import { drainAppHostingStripeReclaims } from '../stripe-reclaim';

const subId = `sub_${createId()}`;

beforeAll(ensureTestDb);

afterEach(async () => {
  await db.delete(appHostingStripeReclaims).where(eq(appHostingStripeReclaims.stripeSubscriptionId, subId));
});

describe('the reclaim drain never discards a concurrent upgrade to "cancel now"', () => {
  it('WAL-9 (partial) a period-end release upgraded to an immediate cancel mid-drain is cancelled now, and only then cleared (D-OW-64)', async () => {
    // Oldest first, so this tick's batch reaches it.
    await db.insert(appHostingStripeReclaims).values({ stripeSubscriptionId: subId, publishedAppId: 'app-x', cancelAt: 'period_end', recordedAt: new Date(0) });
    mockUpdate.mockImplementation(async () => {
      // The app is destroyed while Stripe is answering: its upsert upgrades the row to "now".
      await db.update(appHostingStripeReclaims).set({ cancelAt: 'now' }).where(eq(appHostingStripeReclaims.stripeSubscriptionId, subId));
      return { status: 'active', cancel_at_period_end: true };
    });
    mockCancel.mockResolvedValue({ status: 'canceled' });

    await drainAppHostingStripeReclaims();

    expect(mockUpdate).toHaveBeenCalledWith(subId, { cancel_at_period_end: true });
    expect(mockCancel).toHaveBeenCalledWith(subId);
    expect(await db.select().from(appHostingStripeReclaims).where(eq(appHostingStripeReclaims.stripeSubscriptionId, subId))).toEqual([]);
  });
});
