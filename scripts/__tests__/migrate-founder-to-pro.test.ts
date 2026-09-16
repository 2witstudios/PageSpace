/**
 * A-9 / [D-OW-19] — scripts/migrate-founder-to-pro.ts is DATABASE-ONLY.
 *
 * Founder→Pro is a manual Stripe dashboard step; this script only reports the
 * Founder-price subscriptions (reading Stripe), normalizes a stored 'founder'
 * tier, and grandfathers the $100 personal Business subscribers.
 *
 * The store is a stateful in-memory table that RECORDS every write, and the
 * Stripe client handed to the real adapter records every method it is asked
 * for, so "no writes" is a real assertion, not a vacuous one.
 */
import { describe, it, expect } from 'vitest';
import {
  runFounderMigration,
  parseMode,
  createStripeReader,
  type MigrationStore,
  type StripeSubscriptionReader,
} from '../migrate-founder-to-pro';

const PRICE = { founder: 'price_founder_50', pro: 'price_pro_15', legacyBusiness: 'price_business_100' };
const PERIOD_END = 1_790_000_000; // unix seconds

interface UserRow {
  id: string;
  subscriptionTier: string;
  subscriptionGrandfathered: boolean;
}
interface SubRow {
  userId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  status: string;
}

/** Jono on Founder (tier stored as 'founder'), one $100 personal Business user, one already-flagged, one Pro user. */
function seed() {
  const users: UserRow[] = [
    { id: 'user_jono', subscriptionTier: 'founder', subscriptionGrandfathered: false },
    { id: 'user_biz100', subscriptionTier: 'business', subscriptionGrandfathered: false },
    { id: 'user_biz_done', subscriptionTier: 'business', subscriptionGrandfathered: true },
    { id: 'user_pro', subscriptionTier: 'pro', subscriptionGrandfathered: false },
  ];
  const subs: SubRow[] = [
    { userId: 'user_jono', stripeSubscriptionId: 'sub_jono', stripePriceId: PRICE.founder, status: 'active' },
    { userId: 'user_biz100', stripeSubscriptionId: 'sub_biz100', stripePriceId: PRICE.legacyBusiness, status: 'active' },
    { userId: 'user_biz_done', stripeSubscriptionId: 'sub_biz_done', stripePriceId: PRICE.legacyBusiness, status: 'active' },
    { userId: 'user_pro', stripeSubscriptionId: 'sub_pro', stripePriceId: PRICE.pro, status: 'active' },
  ];
  return { users, subs };
}

function fakeStore(db: ReturnType<typeof seed>) {
  const writes = { setTier: [] as { userId: string; tier: string }[], markGrandfathered: [] as string[] };
  const store: MigrationStore = {
    listFounderPriceSubscriptions: async () =>
      db.subs
        .filter((s) => s.stripePriceId === PRICE.founder)
        .map((s) => ({ userId: s.userId, stripeSubscriptionId: s.stripeSubscriptionId, status: s.status })),
    listFounderTierUsers: async () =>
      db.users
        .filter((u) => u.subscriptionTier === 'founder')
        .map((u) => ({ userId: u.id, stripePriceId: db.subs.find((s) => s.userId === u.id)?.stripePriceId ?? null })),
    normalizeFounderTier: async (userId, tier) => {
      writes.setTier.push({ userId, tier });
      const user = db.users.find((u) => u.id === userId);
      if (user && user.subscriptionTier === 'founder') user.subscriptionTier = tier;
    },
    listLegacyBusinessSubscribers: async () =>
      db.subs
        .filter((s) => s.stripePriceId === PRICE.legacyBusiness)
        .map((s) => ({
          userId: s.userId,
          subscriptionGrandfathered: db.users.find((u) => u.id === s.userId)?.subscriptionGrandfathered ?? false,
        })),
    markGrandfathered: async (userId) => {
      writes.markGrandfathered.push(userId);
      const user = db.users.find((u) => u.id === userId);
      if (user) user.subscriptionGrandfathered = true;
    },
  };
  return { store, writes };
}

/** A Stripe-shaped client that records every method path called on it. */
function recordingStripeClient(subscription: unknown) {
  const calls: string[] = [];
  const client = new Proxy(
    {},
    {
      get: (_t, resource: string) =>
        new Proxy(
          {},
          {
            get: (_r, method: string) => async () => {
              calls.push(`${resource}.${method}`);
              if (resource === 'subscriptions' && method === 'retrieve') return subscription;
              throw new Error(`unexpected Stripe call ${resource}.${method}`);
            },
          },
        ),
    },
  );
  return { client: client as unknown as import('stripe').Stripe, calls };
}

const liveFounderSub = {
  id: 'sub_jono',
  status: 'active',
  schedule: null,
  items: { data: [{ price: { id: PRICE.founder }, current_period_end: PERIOD_END }] },
};

// Mirrors apps/web/src/lib/stripe/price-config.ts: the grandfathered Founder price resolves to Pro.
const deriveTier = (priceId: string) =>
  ({ [PRICE.founder]: 'pro', [PRICE.pro]: 'pro', [PRICE.legacyBusiness]: 'business' } as const)[priceId] ?? 'free';

function harness(db = seed(), subscription: unknown = liveFounderSub) {
  const { store, writes } = fakeStore(db);
  const { client, calls } = recordingStripeClient(subscription);
  const lines: string[] = [];
  const deps = { store, stripe: createStripeReader(client), deriveTier, log: (l: string) => lines.push(l) };
  return { db, deps, writes, calls, lines };
}

describe('parseMode', () => {
  it('defaults to a dry run', () => {
    expect(parseMode([])).toEqual({ apply: false });
  });
  it('writes only with --apply', () => {
    expect(parseMode(['--apply'])).toEqual({ apply: true });
    expect(parseMode(['--dry-run'])).toEqual({ apply: false });
  });
  it('refuses --apply together with --dry-run', () => {
    expect(() => parseMode(['--apply', '--dry-run'])).toThrow();
  });
});

describe('the Founder-price report', () => {
  it('reports user, status, period end and schedule presence from a read-only Stripe call — zero Stripe writes', async () => {
    const h = harness(seed(), { ...liveFounderSub, schedule: 'sub_sched_1' });
    const summary = await runFounderMigration(h.deps, { apply: true });

    expect(h.calls).toEqual(['subscriptions.retrieve']);
    expect(summary.report).toEqual([
      {
        userId: 'user_jono',
        stripeSubscriptionId: 'sub_jono',
        status: 'active',
        currentPeriodEnd: new Date(PERIOD_END * 1000).toISOString(),
        scheduleId: 'sub_sched_1',
      },
    ]);
    expect(h.lines.join('\n')).toContain('user_jono');
    expect(h.lines.join('\n')).toContain('schedule sub_sched_1');
  });

  it('reports "no schedule" when the subscription carries none', async () => {
    const h = harness();
    const summary = await runFounderMigration(h.deps, { apply: false });
    expect(summary.report[0].scheduleId).toBeNull();
    expect(h.lines.join('\n')).toContain('no schedule');
  });

  it('keeps going when a Stripe read fails, and still writes nothing to Stripe', async () => {
    const h = harness();
    const deps = { ...h.deps, stripe: { retrieveSubscription: async () => Promise.reject(new Error('boom')) } satisfies StripeSubscriptionReader };
    const summary = await runFounderMigration(deps, { apply: true });
    expect(summary.report).toEqual([]);
    expect(summary.reportFailed).toBe(1);
    expect(summary.normalized).toBe(1);
    expect(summary.grandfathered).toBe(1);
  });
});

describe('--dry-run (the default)', () => {
  it('writes nothing to the database but says what it would do', async () => {
    const h = harness();
    const summary = await runFounderMigration(h.deps, { apply: false });

    expect(h.writes.setTier).toEqual([]);
    expect(h.writes.markGrandfathered).toEqual([]);
    expect(h.db).toEqual(seed());
    expect(summary.normalized).toBe(1);
    expect(summary.grandfathered).toBe(1);
    expect(h.lines.every((l) => l.startsWith('[dry-run]'))).toBe(true);
  });
});

describe('--apply', () => {
  it("normalizes the stored 'founder' tier to its derived tier, 'pro'", async () => {
    const h = harness();
    await runFounderMigration(h.deps, { apply: true });

    expect(h.writes.setTier).toEqual([{ userId: 'user_jono', tier: 'pro' }]);
    expect(h.db.users.find((u) => u.id === 'user_jono')?.subscriptionTier).toBe('pro');
  });

  it('grandfathers exactly the un-flagged $100 personal Business rows and touches no other user', async () => {
    const h = harness();
    const summary = await runFounderMigration(h.deps, { apply: true });

    expect(h.writes.markGrandfathered).toEqual(['user_biz100']);
    expect(summary.alreadyGrandfathered).toBe(1);
    expect(h.db.users.filter((u) => u.subscriptionGrandfathered).map((u) => u.id).sort()).toEqual(['user_biz100', 'user_biz_done']);
    expect(h.db.users.find((u) => u.id === 'user_pro')).toEqual(seed().users.find((u) => u.id === 'user_pro'));
  });

  it("leaves a 'founder' user with no subscription price for a human, rather than writing Free", async () => {
    const db = seed();
    db.subs = db.subs.filter((s) => s.userId !== 'user_jono');
    const h = harness(db);
    const summary = await runFounderMigration(h.deps, { apply: true });

    expect(h.writes.setTier).toEqual([]);
    expect(summary.founderTierUnresolved).toBe(1);
    expect(h.lines.join('\n')).toContain('user_jono');
  });

  it('is a no-op on a second run', async () => {
    const db = seed();
    await runFounderMigration(harness(db).deps, { apply: true });
    const second = harness(db);
    const summary = await runFounderMigration(second.deps, { apply: true });

    expect(second.writes.setTier).toEqual([]);
    expect(second.writes.markGrandfathered).toEqual([]);
    expect(summary.normalized).toBe(0);
    expect(summary.grandfathered).toBe(0);
    expect(summary.alreadyGrandfathered).toBe(2);
    expect(second.calls).toEqual(['subscriptions.retrieve']);
  });
});
