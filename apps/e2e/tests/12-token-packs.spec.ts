import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { seedUser, getBalance, getLedger } from '../support/db';
import { sessionPost } from '../support/http';
import { stripeSignature, creditPackEvent } from '../support/sign';
import { CREDIT_PACKS } from '../../../packages/lib/src/billing/credit-pricing';

/**
 * Buying a token (credit) pack, end-to-end on the funding side. There are no persistent
 * Stripe Product/Price objects — checkout uses inline price_data from CREDIT_PACKS — so
 * the contract under test is: a paid `checkout.session.completed` webhook with
 * metadata.kind='credit_pack' credits the never-expiring top-up bucket exactly once.
 */

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('credit-pack checkout creation (validation)', () => {
  test('rejects an unknown pack with 400', async ({ request }) => {
    const user = await seedUser({ tier: 'pro' });
    const res = await sessionPost(request, '/api/stripe/create-credit-topup', user, {
      packId: 'pack_does_not_exist',
    });
    expect(res.status()).toBe(400);
  });

  test('rejects a missing packId with 400', async ({ request }) => {
    const user = await seedUser({ tier: 'pro' });
    const res = await sessionPost(request, '/api/stripe/create-credit-topup', user, {});
    expect(res.status()).toBe(400);
  });
});

test.describe('credit-pack webhook funding', () => {
  test('a paid credit_pack session credits the top-up bucket exactly once', async ({ request }) => {
    const pack = CREDIT_PACKS.pack_10;
    const user = await seedUser({ tier: 'pro', topupRemainingCents: 0 });

    const before = (await getBalance(user.userId))?.topupRemainingCents ?? 0;
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;
    const payload = JSON.stringify(
      creditPackEvent({ eventId, userId: user.userId, packId: pack.id, packCents: pack.cents }),
    );

    const post = () =>
      request.post('/api/stripe/webhook', {
        headers: { 'stripe-signature': stripeSignature(payload), 'content-type': 'application/json' },
        data: payload,
      });

    const res1 = await post();
    expect(res1.status()).toBe(200);

    await expect
      .poll(async () => (await getBalance(user.userId))?.topupRemainingCents, { timeout: 10_000 })
      .toBe(before + pack.cents);

    const purchases = await getLedger(user.userId, 'topup_purchase');
    expect(purchases).toHaveLength(1);
    expect(purchases[0].amountCents).toBe(pack.cents);

    // Stripe redelivers events; the same event id must be idempotent — no double credit.
    const res2 = await post();
    expect(res2.status()).toBe(200);

    // Give any (incorrect) second funding a chance to land, then assert it did not.
    await new Promise((r) => setTimeout(r, 500));
    expect((await getBalance(user.userId))?.topupRemainingCents).toBe(before + pack.cents);
    expect(await getLedger(user.userId, 'topup_purchase')).toHaveLength(1);
  });
});
