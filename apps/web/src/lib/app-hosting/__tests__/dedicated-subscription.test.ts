/**
 * Re-buying always-on after a subscription has ended.
 *
 * The mirror row OUTLIVES the subscription on purpose — it is what explains why an
 * app went back to metered — so "has a row" and "is currently paying" are different
 * questions, and the purchase path must ask the second one. Asking the first would
 * mean a single abandoned checkout, or one ordinary cancellation, permanently
 * bricks the SKU for that app: every future purchase answers `already_subscribed`,
 * and the cancel escape hatch cannot help either, because cancelling an
 * already-terminal Stripe subscription errors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSubscriptionsCreate, mockPricesRetrieve, mockSubscriptionsCancel, mockSubscriptionsUpdate } = vi.hoisted(() => ({
  mockSubscriptionsCreate: vi.fn(),
  mockPricesRetrieve: vi.fn(),
  mockSubscriptionsCancel: vi.fn(async () => ({})),
  mockSubscriptionsUpdate: vi.fn(),
}));
vi.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: { create: mockSubscriptionsCreate, update: mockSubscriptionsUpdate, cancel: mockSubscriptionsCancel },
    prices: { retrieve: mockPricesRetrieve },
  },
}));
vi.mock('@/lib/stripe-customer', () => ({ getOrCreateStripeCustomer: vi.fn(async () => 'cus_1') }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
}));

type MockMirrorWriteResult = {
  outcome: 'applied' | 'stale_event' | 'terminal_absorbed' | 'app_destroying';
  row: { publishedAppId: string; status: string } | null;
};

const { mockFindForApp, mockRecord, mockPurchasable } = vi.hoisted(() => ({
  mockFindForApp: vi.fn(),
  mockRecord: vi.fn(
    async (facts: { publishedAppId: string; status: string }): Promise<MockMirrorWriteResult> => ({
      outcome: 'applied',
      row: { publishedAppId: facts.publishedAppId, status: facts.status },
    }),
  ),
  mockPurchasable: vi.fn(() => true),
}));
vi.mock('@pagespace/lib/services/app-hosting/dedicated-tier-service', () => ({
  findDedicatedSubscriptionForApp: mockFindForApp,
  recordDedicatedSubscription: mockRecord,
  isDedicatedTierPurchasable: mockPurchasable,
}));

import { startDedicatedSubscription, cancelDedicatedSubscription } from '../dedicated-subscription';

const NOW = Math.floor(Date.now() / 1000);
const user = { id: 'user_1', email: 'a@b.c', name: 'A', stripeCustomerId: 'cus_1' };

function buy() {
  return startDedicatedSubscription({
    publishedAppId: 'app_1',
    user,
    guestPreset: 'shared-cpu-1x-512',
  });
}

/** A mirror row in whatever state the test needs. */
const mirror = (status: string) => ({
  publishedAppId: 'app_1',
  userId: 'user_1',
  stripeSubscriptionId: 'sub_old',
  stripePriceId: 'price_old',
  guestPreset: 'shared-cpu-1x-512',
  status,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockPurchasable.mockReturnValue(true);
  process.env.DEDICATED_PRICE_ID_SHARED_CPU_1X_512 = 'price_dedicated_1';
  // Comfortably above the derived floor, so price validation is never what a test
  // below is actually measuring.
  mockPricesRetrieve.mockResolvedValue({
    active: true,
    currency: 'usd',
    unit_amount: 50_000,
    recurring: { interval: 'month', interval_count: 1 },
  });
  mockSubscriptionsCreate.mockResolvedValue({
    id: 'sub_new',
    status: 'incomplete',
    cancel_at_period_end: false,
    items: { data: [{ id: 'si_1', current_period_start: NOW, current_period_end: NOW + 2_592_000 }] },
    latest_invoice: { confirmation_secret: { client_secret: 'cs_test' } },
  });
});

describe('buying always-on when a live subscription already exists', () => {
  it('refuses while the subscription is paying', async () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      mockFindForApp.mockResolvedValue(mirror(status));
      const result = await buy();
      expect(result, `a ${status} subscription must block a second charge`).toEqual({
        ok: false,
        reason: 'already_subscribed',
      });
    }
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('refuses while a checkout is still open', async () => {
    // The customer has a payment sheet in front of them right now; issuing a second
    // subscription would let them pay twice for one app.
    mockFindForApp.mockResolvedValue(mirror('incomplete'));
    expect(await buy()).toEqual({ ok: false, reason: 'already_subscribed' });
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });
});

describe('buying always-on again after the last subscription ended', () => {
  it('succeeds after an ordinary cancellation', async () => {
    mockFindForApp.mockResolvedValue(mirror('canceled'));
    const result = await buy();
    expect(result.ok, 'a cancelled subscription must not brick the SKU for this app').toBe(true);
    expect(mockSubscriptionsCreate).toHaveBeenCalled();
  });

  it('succeeds after an abandoned checkout', async () => {
    // The case that would otherwise be permanent: one customer starting a checkout
    // and walking away leaves an `incomplete_expired` row forever.
    mockFindForApp.mockResolvedValue(mirror('incomplete_expired'));
    const result = await buy();
    expect(result.ok, 'an abandoned checkout must not brick the SKU for this app').toBe(true);
  });

  it('succeeds after an unpaid subscription', async () => {
    mockFindForApp.mockResolvedValue(mirror('unpaid'));
    expect((await buy()).ok).toBe(true);
  });

  it('succeeds when the app has never had one', async () => {
    mockFindForApp.mockResolvedValue(null);
    expect((await buy()).ok).toBe(true);
  });
});

describe('the purchase is refused before Stripe is touched', () => {
  it('makes no Stripe call where billing is disabled', async () => {
    mockPurchasable.mockReturnValue(false);
    mockFindForApp.mockResolvedValue(null);
    expect(await buy()).toEqual({ ok: false, reason: 'unavailable' });
    expect(mockPricesRetrieve).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('makes no Stripe call for a size the dedicated tier may not run', async () => {
    mockFindForApp.mockResolvedValue(null);
    const result = await startDedicatedSubscription({
      publishedAppId: 'app_1',
      user,
      guestPreset: 'shared-cpu-64x-262144',
    });
    expect(result).toEqual({ ok: false, reason: 'guest_preset_not_allowed' });
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('makes no Stripe subscription for an unconfigured price', async () => {
    // Fail-closed: a deployment that has not been given prices cannot sell at one.
    delete process.env.DEDICATED_PRICE_ID_SHARED_CPU_1X_512;
    mockFindForApp.mockResolvedValue(null);
    expect(await buy()).toEqual({ ok: false, reason: 'price_not_configured' });
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('refuses a price below the substrate floor', async () => {
    // This guard is the only thing that makes MACHINE_MARKUP_BPS bind on a flat
    // SKU, whose price is typed into a dashboard by a person.
    mockFindForApp.mockResolvedValue(null);
    mockPricesRetrieve.mockResolvedValue({
      active: true,
      currency: 'usd',
      unit_amount: 100,
      recurring: { interval: 'month', interval_count: 1 },
    });
    expect(await buy()).toEqual({ ok: false, reason: 'price_below_floor' });
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('refuses a price that is not monthly USD', async () => {
    mockFindForApp.mockResolvedValue(null);
    mockPricesRetrieve.mockResolvedValue({
      active: true,
      currency: 'usd',
      unit_amount: 500_000,
      recurring: { interval: 'year', interval_count: 1 },
    });
    expect(await buy()).toEqual({ ok: false, reason: 'price_not_monthly_usd' });
  });
});

describe('a successful purchase', () => {
  it('stamps the discriminator that keeps it out of the account-tier machinery', async () => {
    mockFindForApp.mockResolvedValue(null);
    await buy();
    const args = mockSubscriptionsCreate.mock.calls[0][0];
    expect(args.metadata.kind).toBe('published_app_dedicated');
    expect(args.metadata.publishedAppId).toBe('app_1');
  });

  it('does NOT make the app dedicated — entitlement waits for Stripe', async () => {
    // The subscription is created `incomplete`, i.e. unpaid. Flipping the tier here
    // would hand an always-on machine to anyone who starts a checkout and abandons
    // it.
    mockFindForApp.mockResolvedValue(null);
    await buy();
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ status: 'incomplete' }));
  });
});

describe('the app is destroyed between the price check and the mirror write', () => {
  // recordDedicatedSubscription's own `published_apps` row lock can refuse the
  // write outright (`outcome: 'app_destroying'`) if a concurrent unpublish
  // committed first. By that point Stripe has already minted the subscription
  // above — leaving it live would charge for an app that no longer exists, with
  // no local mirror ever able to reclaim it.
  it('cancels the just-created Stripe subscription and refuses', async () => {
    mockFindForApp.mockResolvedValue(null);
    mockRecord.mockResolvedValueOnce({ outcome: 'app_destroying', row: null });

    const result = await buy();

    expect(result).toEqual({ ok: false, reason: 'app_destroying' });
    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_new');
  });

  it('does not throw the purchase call even if the compensating cancel itself fails', async () => {
    mockFindForApp.mockResolvedValue(null);
    mockRecord.mockResolvedValueOnce({ outcome: 'app_destroying', row: null });
    mockSubscriptionsCancel.mockRejectedValueOnce(new Error('stripe down'));

    await expect(buy()).resolves.toEqual({ ok: false, reason: 'app_destroying' });
  });
});

describe('two overlapping purchases for the same app', () => {
  it('sends Stripe an idempotency key, so the race cannot mint two subscriptions', async () => {
    // The live-subscription read cannot serialize anything: two POSTs read before
    // either writes, both pass, and both call `subscriptions.create`. Stripe would
    // mint TWO recurring charges and the mirror's UNIQUE keeps one pointer —
    // leaving the other billing the customer monthly with nothing naming it.
    mockFindForApp.mockResolvedValue(null);
    await buy();
    const [, options] = mockSubscriptionsCreate.mock.calls[0];
    expect(options?.idempotencyKey).toBe('pgs-dedicated:app_1:none');
  });

  it('gives two racing requests the SAME key', async () => {
    // They agree on what they read, so they agree on the key, so Stripe answers
    // both with one subscription.
    mockFindForApp.mockResolvedValue(null);
    await Promise.all([buy(), buy()]);
    const keys = mockSubscriptionsCreate.mock.calls.map((c) => c[1]?.idempotencyKey);
    expect(new Set(keys).size, 'racing requests must not compute different keys').toBe(1);
  });

  it('gives a genuine RE-BUY a different key', async () => {
    // Otherwise Stripe would answer a real new purchase with the dead
    // subscription it already created under that key.
    mockFindForApp.mockResolvedValue(mirror('canceled'));
    await buy();
    const [, options] = mockSubscriptionsCreate.mock.calls[0];
    expect(options?.idempotencyKey).toBe('pgs-dedicated:app_1:sub_old');
  });
});

describe('cancelling always-on', () => {
  beforeEach(() => {
    mockFindForApp.mockResolvedValue(mirror('active'));
    mockSubscriptionsUpdate.mockResolvedValue({
      id: 'sub_old',
      status: 'active',
      cancel_at_period_end: true,
      items: { data: [{ current_period_start: NOW, current_period_end: NOW + 2_592_000 }] },
    });
  });

  it('succeeds even when the mirror write is refused because the app is being destroyed concurrently', async () => {
    mockRecord.mockResolvedValueOnce({ outcome: 'app_destroying', row: null });

    const result = await cancelDedicatedSubscription('app_1');

    // The Stripe-side cancel-at-period-end already happened and that is the
    // outcome that matters here — the app's own unpublish reclaim outbox owns
    // cancelling this subscription for real, immediately, regardless of
    // whether the local mirror reflects the update.
    expect(result).toEqual({ ok: true, cancelAtPeriodEnd: true, currentPeriodEnd: expect.any(Date) });
  });

  it('succeeds normally when the mirror write applies', async () => {
    const result = await cancelDedicatedSubscription('app_1');
    expect(result).toEqual({ ok: true, cancelAtPeriodEnd: true, currentPeriodEnd: expect.any(Date) });
  });
});
