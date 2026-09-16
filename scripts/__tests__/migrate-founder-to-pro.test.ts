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
  migrationPriceIds,
  selectFounderPriceSubscriptions,
  selectFounderTierUsers,
  founderTierToWrite,
  selectLegacyBusinessSubscribers,
  type MigrationStore,
  type SubscribedUserCandidate,
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
  updatedAt?: Date;
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

/** Raw user ⟕ subscription rows, as the drizzle store reads them before selection. */
function candidates(db: ReturnType<typeof seed>): SubscribedUserCandidate[] {
  return db.users.flatMap((u): SubscribedUserCandidate[] => {
    const subs = db.subs.filter((s) => s.userId === u.id);
    const base = { userId: u.id, subscriptionTier: u.subscriptionTier, subscriptionGrandfathered: u.subscriptionGrandfathered };
    if (subs.length === 0) return [{ ...base, stripeSubscriptionId: null, stripePriceId: null, status: null, updatedAt: null }];
    return subs.map((s) => ({ ...base, stripeSubscriptionId: s.stripeSubscriptionId, stripePriceId: s.stripePriceId, status: s.status, updatedAt: s.updatedAt ?? null }));
  });
}

function fakeStore(db: ReturnType<typeof seed>) {
  const writes = { setTier: [] as { userId: string; tier: string }[], markGrandfathered: [] as string[] };
  const store: MigrationStore = {
    listFounderPriceSubscriptions: async () => selectFounderPriceSubscriptions(candidates(db), PRICE.founder),
    listFounderTierUsers: async () => selectFounderTierUsers(candidates(db)),
    normalizeFounderTier: async (userId, tier) => {
      writes.setTier.push({ userId, tier });
      const user = db.users.find((u) => u.id === userId);
      if (user && user.subscriptionTier === 'founder') user.subscriptionTier = tier;
    },
    listLegacyBusinessSubscribers: async () => selectLegacyBusinessSubscribers(candidates(db), PRICE.legacyBusiness),
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
const TIER_BY_PRICE: Record<string, 'pro' | 'business'> = { [PRICE.founder]: 'pro', [PRICE.pro]: 'pro', [PRICE.legacyBusiness]: 'business' };
const deriveTier = (priceId: string): 'free' | 'pro' | 'business' => TIER_BY_PRICE[priceId] ?? 'free';

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

  it('leaves a founder-tier user whose Founder subscription is canceled at Free-equivalent, with no write', async () => {
    const db = seed();
    db.subs = db.subs.map((s) => (s.userId === 'user_jono' ? { ...s, status: 'canceled' } : s));
    const h = harness(db);
    const summary = await runFounderMigration(h.deps, { apply: true });

    expect(h.writes.setTier).toEqual([]);
    expect(summary.normalized).toBe(0);
    expect(summary.founderTierUnresolved).toBe(1);
    expect(db.users.find((u) => u.id === 'user_jono')?.subscriptionTier).toBe('founder');
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

describe('migrationPriceIds', () => {
  it('grandfathers on the legacy $100 price id, not whatever Business sells today', () => {
    const config = {
      priceIds: { pro: PRICE.pro, business: 'price_business_org_50' },
      grandfatheredPriceIds: { founder: PRICE.founder, legacyBusiness: PRICE.legacyBusiness },
    };
    expect(migrationPriceIds(config)).toEqual({ founder: PRICE.founder, legacyBusiness: PRICE.legacyBusiness });
  });

  it('reads a legacyBusiness id from the real Stripe config, identical in web and admin', async () => {
    const web = await import('../../apps/web/src/lib/stripe-config');
    const admin = await import('../../apps/admin/src/lib/stripe-config');
    expect(web.stripeConfig.grandfatheredPriceIds.legacyBusiness).toMatch(/^price_/);
    expect(migrationPriceIds(web.stripeConfig).legacyBusiness).toBe(web.stripeConfig.grandfatheredPriceIds.legacyBusiness);
    expect(admin.stripeConfig.grandfatheredPriceIds).toEqual(web.stripeConfig.grandfatheredPriceIds);
  });
});

function candidate(overrides: Partial<SubscribedUserCandidate>): SubscribedUserCandidate {
  return {
    userId: 'u',
    subscriptionTier: 'business',
    subscriptionGrandfathered: false,
    stripeSubscriptionId: 'sub',
    stripePriceId: PRICE.legacyBusiness,
    status: 'active',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('selectLegacyBusinessSubscribers', () => {
  it('keeps active, trialing and past_due subscribers on the legacy price, once per user', () => {
    const rows = [
      candidate({ userId: 'a', status: 'active' }),
      candidate({ userId: 'b', status: 'trialing' }),
      candidate({ userId: 'c', status: 'past_due', subscriptionGrandfathered: true }),
      candidate({ userId: 'a', stripeSubscriptionId: 'sub_a2', status: 'active' }),
    ];
    expect(selectLegacyBusinessSubscribers(rows, PRICE.legacyBusiness)).toEqual([
      { userId: 'a', subscriptionGrandfathered: false },
      { userId: 'b', subscriptionGrandfathered: false },
      { userId: 'c', subscriptionGrandfathered: true },
    ]);
  });

  it('never grandfathers a canceled, unpaid or incomplete subscriber, or one on another price', () => {
    const rows = [
      candidate({ userId: 'canceled', status: 'canceled' }),
      candidate({ userId: 'unpaid', status: 'unpaid' }),
      candidate({ userId: 'incomplete', status: 'incomplete_expired' }),
      candidate({ userId: 'org', stripePriceId: 'price_business_org_50' }),
      candidate({ userId: 'nosub', stripeSubscriptionId: null, stripePriceId: null, status: null, updatedAt: null }),
    ];
    expect(selectLegacyBusinessSubscribers(rows, PRICE.legacyBusiness)).toEqual([]);
  });
});

describe('selectFounderPriceSubscriptions', () => {
  it('reports every subscription on the Founder price, whatever its status', () => {
    const rows = [
      candidate({ userId: 'jono', stripeSubscriptionId: 'sub_j', stripePriceId: PRICE.founder, status: 'canceled' }),
      candidate({ userId: 'biz' }),
    ];
    expect(selectFounderPriceSubscriptions(rows, PRICE.founder)).toEqual([
      { userId: 'jono', stripeSubscriptionId: 'sub_j', status: 'canceled' },
    ]);
  });
});

describe('selectFounderTierUsers', () => {
  const founder = (o: Partial<SubscribedUserCandidate>) => candidate({ userId: 'jono', subscriptionTier: 'founder', stripePriceId: PRICE.founder, ...o });

  it('groups every subscription row of each founder-tier user, whatever its status, in a deterministic order', () => {
    const older = founder({ stripeSubscriptionId: 'sub_old', status: 'canceled', updatedAt: new Date('2026-01-01T00:00:00Z') });
    const newer = founder({ stripeSubscriptionId: 'sub_new', status: 'active', updatedAt: new Date('2026-06-01T00:00:00Z') });
    const expected = [{ userId: 'jono', subscriptions: [{ status: 'active', stripePriceId: PRICE.founder }, { status: 'canceled', stripePriceId: PRICE.founder }] }];
    expect(selectFounderTierUsers([older, newer])).toEqual(expected);
    expect(selectFounderTierUsers([newer, older])).toEqual(expected);
  });

  it('keeps a founder-tier user with no subscription (empty rows) and ignores other tiers', () => {
    const rows = [
      founder({ stripeSubscriptionId: null, stripePriceId: null, status: null, updatedAt: null }),
      candidate({ userId: 'p', subscriptionTier: 'pro' }),
    ];
    expect(selectFounderTierUsers(rows)).toEqual([{ userId: 'jono', subscriptions: [] }]);
  });
});

describe('founderTierToWrite', () => {
  it("writes 'pro' for an active or trialing Founder subscription", () => {
    expect(founderTierToWrite([{ status: 'active', stripePriceId: PRICE.founder }], deriveTier)).toBe('pro');
    expect(founderTierToWrite([{ status: 'trialing', stripePriceId: PRICE.founder }], deriveTier)).toBe('pro');
  });

  it('never promotes a canceled, expired or past_due subscriber (webhook parity: they already read as Free)', () => {
    for (const status of ['canceled', 'incomplete_expired', 'past_due', 'unpaid']) {
      expect(founderTierToWrite([{ status, stripePriceId: PRICE.founder }], deriveTier)).toBeNull();
      expect(founderTierToWrite([{ status, stripePriceId: PRICE.legacyBusiness }], deriveTier)).toBeNull();
    }
  });

  it('leaves an unmapped price, or no subscription, for a human', () => {
    expect(founderTierToWrite([{ status: 'active', stripePriceId: 'price_unknown' }], deriveTier)).toBeNull();
    expect(founderTierToWrite([], deriveTier)).toBeNull();
    // A mapped paid row beside an unmapped entitled row is only a lower bound, not the truth.
    const mixed = [
      { status: 'active', stripePriceId: PRICE.founder },
      { status: 'active', stripePriceId: 'price_unknown' },
    ];
    expect(founderTierToWrite(mixed, deriveTier)).toBeNull();
  });
});
