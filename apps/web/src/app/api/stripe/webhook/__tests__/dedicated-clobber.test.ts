/**
 * THE CLOBBER GUARD.
 *
 * A dedicated-hosting subscription and an account plan are both
 * `customer.subscription.*` events on the same Stripe customer, and the account
 * handler assumes every one of them IS that customer's plan. If a hosting
 * subscription ever reaches `handleSubscriptionChange`, it derives an account tier
 * from a price the tier map does not know — `free` — and writes that over a paying
 * Pro / Founder / Business customer's `users.subscriptionTier`. The reconcile cron
 * then reads their entitled-but-unmapped row as `indeterminate` and deliberately
 * refuses to auto-repair it, so the demotion is permanent AND invisible to the
 * machinery built for exactly that failure. The same fork protects the credit
 * bucket: `applyStripeFunding` refills the monthly AI allowance on every paid
 * subscription invoice, so an unforked hosting invoice grants a free refill every
 * month on its own billing anchor.
 *
 * These tests are the proof that the fork holds, in both directions. Break
 * `routeSubscription`/`routeInvoice` (or the `metadata.kind` they read) and the
 * "leaves the tier untouched" / "does not refill" cases go red.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

const { mockConstructEvent, StripeError } = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  StripeError: class extends Error {},
}));
vi.mock('@/lib/stripe', () => ({
  stripe: { webhooks: { constructEvent: mockConstructEvent } },
  Stripe: { errors: { StripeError } },
  getTierFromPrice: vi.fn(() => 'free'),
}));

/**
 * A db double that records every UPDATE's SET payload, which is the only thing
 * these tests need to observe: the clobber IS an update to `users`.
 */
const mockDb = vi.hoisted(() => {
  const state: { updateSets: Array<Record<string, unknown>>; userRows: unknown[] } = {
    updateSets: [],
    userRows: [],
  };
  const recordUpdate = () => ({
    set: (payload: Record<string, unknown>) => {
      state.updateSets.push(payload);
      return { where: async () => undefined };
    },
  });
  return {
    __state: state,
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => state.userRows }) }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: async () => [{ id: 'evt' }] }),
      }),
    }),
    update: recordUpdate,
    delete: () => ({ where: async () => undefined }),
    transaction: async (cb: (tx: unknown) => Promise<void>) => {
      await cb({
        insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
        update: recordUpdate,
      });
    },
  };
});
vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/operators', () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }),
  and: (...c: unknown[]) => ({ c }),
  isNull: (a: unknown) => ({ a }),
  lte: (a: unknown, b: unknown) => ({ a, b }),
}));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'users.id' } }));
vi.mock('@pagespace/db/schema/subscriptions', () => ({ subscriptions: {}, stripeEvents: {} }));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    auth: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

const mockApplyStripeFunding = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/lib/billing/credit-funding', () => ({ applyStripeFunding: mockApplyStripeFunding }));
vi.mock('@/lib/billing/send-payment-receipt-email', () => ({
  sendSubscriptionReceiptEmail: vi.fn(),
  sendTopupReceiptEmail: vi.fn(),
}));
vi.mock('@/lib/subscription/credit-balance', () => ({ emitCreditsUpdated: vi.fn() }));

/**
 * The hosting service is mocked because it opens a database of its own. What it
 * DOES with a dedicated event is tested in packages/lib; what matters here is
 * only that the event reached it instead of the account handler.
 */
const { mockRecordSubscription, mockSyncTier, mockFindByStripeId } = vi.hoisted(() => ({
  mockRecordSubscription: vi.fn(async () => null),
  mockSyncTier: vi.fn(async () => ({ outcome: 'entitled' as const, publishedAppId: 'app_1', tierChanged: true })),
  mockFindByStripeId: vi.fn(async () => null),
}));
vi.mock('@pagespace/lib/services/app-hosting/dedicated-tier-service', () => ({
  recordDedicatedSubscription: mockRecordSubscription,
  syncAppTierToSubscription: mockSyncTier,
  findDedicatedSubscriptionByStripeId: mockFindByStripeId,
}));

import { POST } from '../route';

/**
 * The wire value, written out rather than imported from `dedicated-tier.ts`.
 *
 * This string is a CONTRACT with Stripe: it is stamped onto live subscriptions
 * and snapshotted onto every invoice they generate, so changing the constant
 * would silently stop routing every subscription already sold. Importing it here
 * would make this test agree with any change to it; spelling it out makes the test
 * fail, which is the correct response to renaming a value that exists in another
 * company's database.
 */
const DEDICATED_SUBSCRIPTION_KIND = 'published_app_dedicated';

const NOW = Math.floor(Date.now() / 1000);

function subscription(metadata: Record<string, string> | undefined): Stripe.Subscription {
  return {
    id: 'sub_hosting_1',
    customer: 'cus_pro_1',
    status: 'active',
    cancel_at_period_end: false,
    metadata,
    items: {
      data: [
        {
          id: 'si_1',
          price: { id: 'price_dedicated_1', unit_amount: 10061 },
          current_period_start: NOW,
          current_period_end: NOW + 2_592_000,
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

function invoice(metadata: Record<string, string> | undefined): Stripe.Invoice {
  return {
    id: 'in_1',
    customer: 'cus_pro_1',
    amount_paid: 10061,
    lines: { data: [{ pricing: { price_details: { price: 'price_dedicated_1' } } }] },
    parent: metadata
      ? { subscription_details: { subscription: 'sub_hosting_1', metadata } }
      : null,
  } as unknown as Stripe.Invoice;
}

function post(type: string, object: unknown) {
  mockConstructEvent.mockReturnValue({
    id: `evt_${type}_${Math.random()}`,
    type,
    data: { object },
  });
  return POST(
    new Request('https://pagespace.ai/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig' },
      body: '{}',
    }) as never,
  );
}

/** Every SET payload that touched the account tier. */
const tierWrites = () => mockDb.__state.updateSets.filter((s) => 'subscriptionTier' in s);

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.__state.updateSets.length = 0;
  // A PAYING customer. This is the person the clobber would demote.
  mockDb.__state.userRows = [{ id: 'user_pro_1', subscriptionTier: 'pro', email: 'pro@example.com', name: 'Pro' }];
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
});

describe('a dedicated hosting subscription', () => {
  const hostingMetadata = {
    kind: DEDICATED_SUBSCRIPTION_KIND,
    publishedAppId: 'app_1',
    userId: 'user_pro_1',
    guestPreset: 'shared-cpu-1x-512',
  };

  it('leaves a paying customer’s account tier untouched', async () => {
    const response = await post('customer.subscription.created', subscription(hostingMetadata));
    expect(response.status).toBe(200);
    expect(
      tierWrites(),
      'a hosting subscription must never write users.subscriptionTier',
    ).toEqual([]);
  });

  it('leaves the tier untouched when the hosting subscription is CANCELLED too', async () => {
    // The deleted event is the more dangerous half: `handleSubscriptionDeleted`
    // sets the tier to `free` unconditionally, so an unforked cancel of a hosting
    // add-on would demote the customer's plan.
    const response = await post('customer.subscription.deleted', subscription(hostingMetadata));
    expect(response.status).toBe(200);
    expect(tierWrites()).toEqual([]);
  });

  it('is handed to the hosting handler instead', async () => {
    await post('customer.subscription.updated', subscription(hostingMetadata));
    expect(mockSyncTier).toHaveBeenCalledWith('sub_hosting_1', 'active');
  });
});

describe('a dedicated hosting invoice', () => {
  const hostingMetadata = { kind: DEDICATED_SUBSCRIPTION_KIND };

  it('does not refill the customer’s monthly AI credits', async () => {
    // Otherwise a customer with a dedicated app gets a second monthly allowance
    // every month, on the hosting subscription's own billing anchor.
    const response = await post('invoice.paid', invoice(hostingMetadata));
    expect(response.status).toBe(200);
    expect(mockApplyStripeFunding).not.toHaveBeenCalled();
  });

  it('does not downgrade anything on a failed payment', async () => {
    const response = await post('invoice.payment_failed', invoice(hostingMetadata));
    expect(response.status).toBe(200);
    expect(tierWrites()).toEqual([]);
  });
});

describe('the existing account-plan path is unchanged', () => {
  it('still writes the tier for a subscription carrying NO metadata', async () => {
    // Fail-closed means THE OLD BEHAVIOUR. Every subscription written before this
    // discriminator existed has no `kind`, and must keep taking this path.
    const response = await post('customer.subscription.created', subscription(undefined));
    expect(response.status).toBe(200);
    expect(tierWrites().length).toBe(1);
  });

  it('still writes the tier for an UNRECOGNISED kind', async () => {
    // Diverting an unknown kind would mean a typo silently stops maintaining a
    // real customer's tier, with nothing left for the reconcile cron to repair.
    const response = await post(
      'customer.subscription.created',
      subscription({ kind: 'something_we_have_never_shipped' }),
    );
    expect(response.status).toBe(200);
    expect(tierWrites().length).toBe(1);
    expect(mockSyncTier).not.toHaveBeenCalled();
  });

  it('still refills credits for an ordinary subscription invoice', async () => {
    const response = await post('invoice.paid', invoice(undefined));
    expect(response.status).toBe(200);
    expect(mockApplyStripeFunding).toHaveBeenCalled();
  });
});
