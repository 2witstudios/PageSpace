import { describe, expect, it } from 'vitest';
import { createStripeReader, parseBusinessManifest, parseMode, planFounderCutover, runFounderMigration, type LiveSubscription, type MigrationDeps, type MigrationUser } from '../migrate-founder-to-pro';

const PRO = 'price_pro';
const person = (overrides: Partial<MigrationUser> = {}): MigrationUser => ({
  id: 'user', tier: 'founder', grandfathered: false, customerId: 'cus_user',
  subscriptions: [{ id: 'sub_user', priceId: PRO, status: 'active' }], ...overrides,
});
const liveSub = (overrides: Partial<LiveSubscription> = {}): LiveSubscription => ({
  customerId: 'cus_user', status: 'active', priceIds: [PRO], scheduled: false, ...overrides,
});
function harness(people = [person()], live = liveSub()) {
  const writes: string[] = [];
  const reads: string[] = [];
  const deps: MigrationDeps = {
    proPriceId: PRO,
    listCandidates: async () => people,
    readCustomerSubscriptions: async (id) => { reads.push(id); return [{ id: 'sub_user', ...live }]; },
    apply: async (updates) => {
      for (const { user, tier } of updates) { writes.push(user.id); user.tier = tier; user.grandfathered = false; }
    },
  };
  return { deps, writes, reads, people };
}

describe('D-OW-42 Founder cutover preflight', () => {
  it('A-9 normalizes synthetic on-prem tiers without Stripe and refuses real billing evidence', async () => {
    const h = harness([person({ tier: 'business', customerId: null, subscriptions: [] })]);
    h.deps.billingEnabled = false;
    h.deps.proPriceId = '';
    expect(await runFounderMigration(h.deps, { apply: true })).toMatchObject({ ready: true, normalized: 1 });
    expect(h.people[0].tier).toBe('free');
    expect(h.reads).toEqual([]);
    h.people[0].customerId = 'cus_unverified';
    expect(await runFounderMigration(h.deps, { apply: true })).toMatchObject({ ready: false, normalized: 0 });
  });
  it('A-9 rejects a mistyped manifest user without writing any other candidate', async () => {
    const h = harness();
    h.deps.businessDestinations = new Map([['missing', 'pro']]);
    expect((await runFounderMigration(h.deps, { apply: true })).ready).toBe(false);
    expect(h.writes).toEqual([]);
  });
  it('A-9 requires an explicit Business destination and verifies it before normalizing', async () => {
    const h = harness([person({ tier: 'business', grandfathered: true })]);
    h.deps.businessDestinations = new Map([['user', 'pro']]);
    expect(await runFounderMigration(h.deps, { apply: false })).toMatchObject({ ready: true, normalized: 1 });
    expect(h.writes).toEqual([]);
    expect(await runFounderMigration(h.deps, { apply: true })).toMatchObject({ ready: true, normalized: 1 });
    expect(h.people[0]).toMatchObject({ tier: 'pro', grandfathered: false });
    expect(await runFounderMigration(h.deps, { apply: true })).toMatchObject({ ready: true, normalized: 0 });
  });
  it('A-9 refuses a manifest destination that differs from verified Stripe evidence', async () => {
    const h = harness([person({ tier: 'business', grandfathered: true })]);
    h.deps.businessDestinations = new Map([['user', 'free']]);
    expect((await runFounderMigration(h.deps, { apply: true })).ready).toBe(false);
    expect(h.writes).toEqual([]);
  });
  it('A-9 permits explicit Free only after the personal subscription has ended', async () => {
    const h = harness([person({ tier: 'business', grandfathered: true,
      subscriptions: [{ id: 'sub_user', priceId: 'price_retired_business', status: 'canceled' }] })],
    liveSub({ status: 'canceled', priceIds: ['price_retired_business'] }));
    h.deps.businessDestinations = new Map([['user', 'free']]);
    expect((await runFounderMigration(h.deps, { apply: true })).ready).toBe(true);
    expect(h.people[0]).toMatchObject({ tier: 'free', grandfathered: false });
  });
  it('A-9 validates a versioned manifest and rejects duplicate or unknown destinations', () => {
    expect(parseBusinessManifest({ version: 1, users: [{ userId: 'user', tier: 'pro' }] })).toEqual(new Map([['user', 'pro']]));
    for (const invalid of [null, {}, { version: 2, users: [] },
      { version: 1, users: [{ userId: 'user', tier: 'business' }] },
      { version: 1, users: [{ userId: 'user', tier: 'pro' }, { userId: 'user', tier: 'free' }] }]) {
      expect(() => parseBusinessManifest(invalid)).toThrow();
    }
  });
  it('defaults to dry-run and rejects contradictory or unknown arguments', () => {
    expect(parseMode([])).toEqual({ apply: false });
    expect(parseMode(['--dry-run'])).toEqual({ apply: false });
    expect(parseMode(['--apply'])).toEqual({ apply: true });
    expect(parseMode(['--business-manifest', '/tmp/destinations.json', '--apply'])).toEqual({ apply: true, businessManifest: '/tmp/destinations.json' });
    expect(() => parseMode(['--business-manifest'])).toThrow();
    expect(() => parseMode(['--apply', '--dry-run'])).toThrow();
    expect(() => parseMode(['--force'])).toThrow();
  });
  it('requires the Stripe switch and matching mirror before normalizing; dry-run writes nothing', async () => {
    const h = harness();
    expect(await runFounderMigration(h.deps, { apply: false })).toMatchObject({ ready: true, normalized: 1 });
    expect(h.writes).toEqual([]);
    expect(h.people[0].tier).toBe('founder');
    expect(h.reads).toEqual(['cus_user']);
  });
  it('normalizes a verified Pro subscription exactly once', async () => {
    const h = harness();
    expect(await runFounderMigration(h.deps, { apply: true })).toMatchObject({ ready: true, normalized: 1 });
    expect(h.people[0].tier).toBe('pro');
    expect(await runFounderMigration(h.deps, { apply: true })).toMatchObject({ ready: true, normalized: 0 });
    expect(h.writes).toEqual(['user']);
  });
  it.each(['price_founder', 'price_unknown', 'price_business'])('blocks still-active retired/unmapped prices (%s), never aliases them to Pro', async (priceId) => {
    const user = person({ subscriptions: [{ id: 'sub_user', priceId, status: 'active' }] });
    const h = harness([user], liveSub({ priceIds: [priceId] }));
    expect(await runFounderMigration(h.deps, { apply: true })).toMatchObject({ ready: false, normalized: 0 });
    expect(h.writes).toEqual([]);
  });
  it.each([
    { scheduled: true }, { customerId: 'cus_other' }, { priceIds: [PRO, 'price_unknown'] }, { priceIds: [] }, { status: 'past_due' },
  ])('blocks incomplete or mismatched live evidence (%j)', async (override) => {
    const h = harness([person()], liveSub(override));
    expect((await runFounderMigration(h.deps, { apply: true })).ready).toBe(false);
    expect(h.writes).toEqual([]);
  });
  it('blocks a stale Founder mirror even after the live Stripe switch', async () => {
    const h = harness([person({ subscriptions: [{ id: 'sub_user', priceId: 'price_founder', status: 'active' }] })]);
    expect((await runFounderMigration(h.deps, { apply: true })).ready).toBe(false);
    expect(h.writes).toEqual([]);
  });
  it('blocks all writes when any Stripe read fails', async () => {
    const h = harness();
    h.deps.readCustomerSubscriptions = async () => { throw new Error('unavailable'); };
    expect((await runFounderMigration(h.deps, { apply: true })).ready).toBe(false);
    expect(h.writes).toEqual([]);
  });
  it('blocks all writes when any Business migration remains, without grandfathering anyone', async () => {
    const h = harness([person(), person({ id: 'business', tier: 'business', grandfathered: true })]);
    expect((await runFounderMigration(h.deps, { apply: true })).ready).toBe(false);
    expect(h.writes).toEqual([]);
    expect(h.people[0].tier).toBe('founder');
  });
  it('requires subscription evidence and configured destination identity', async () => {
    expect(planFounderCutover(person({ subscriptions: [] }), new Map(), PRO).issues.length).toBeGreaterThan(0);
    const h = harness();
    h.deps.proPriceId = '';
    await expect(runFounderMigration(h.deps, { apply: true })).rejects.toThrow('Configured Pro');
    expect(h.writes).toEqual([]);
  });
  it('normalizes an ended Founder subscription to Free without granting a paid tier', async () => {
    const h = harness([person({ subscriptions: [{ id: 'sub_user', priceId: 'price_founder', status: 'canceled' }] })],
      liveSub({ status: 'canceled', priceIds: ['price_founder'] }));
    expect((await runFounderMigration(h.deps, { apply: true })).ready).toBe(true);
    expect(h.people[0].tier).toBe('free');
  });
  it('propagates an apply conflict; never reports readiness after a failed write', async () => {
    const h = harness();
    h.deps.apply = async () => { throw new Error('evidence changed'); };
    await expect(runFounderMigration(h.deps, { apply: true })).rejects.toThrow('evidence changed');
  });
  it.each([true, false])('validates unchanged Pro candidates during apply, with pending writes=%s', async (hasWrites) => {
    const unchanged = person({ id: 'already-pro', tier: 'pro' });
    const people = hasWrites ? [person(), unchanged] : [unchanged];
    const h = harness(people);
    let validated: readonly MigrationUser[] = [];
    h.deps.apply = async (_updates, observed) => {
      validated = observed;
      if (observed.some((user) => user.id === unchanged.id)) throw new Error('evidence changed');
    };
    await expect(runFounderMigration(h.deps, { apply: true })).rejects.toThrow('evidence changed');
    expect(validated).toEqual(people);
    expect(h.writes).toEqual([]);
  });
  it('continues verifying Pro users and catches live subscriptions missing from the mirror', async () => {
    const h = harness([person({ tier: 'pro', subscriptions: [] })]);
    expect((await runFounderMigration(h.deps, { apply: true })).ready).toBe(false);
    expect(h.reads).toEqual(['cus_user']);
    expect(h.writes).toEqual([]);
  });
  it('a failed inventory read blocks rollout even for a customer with no mirrored rows', async () => {
    const h = harness([person({ tier: 'free', subscriptions: [] })]);
    h.deps.readCustomerSubscriptions = async () => { throw new Error('unavailable'); };
    expect((await runFounderMigration(h.deps, { apply: true })).ready).toBe(false);
  });
  it('the Stripe adapter is read-only and refuses truncated item evidence', async () => {
    const calls: string[] = [];
    const subscription = { id: 'sub_user', metadata: {}, customer: 'cus_user', status: 'active', schedule: null, items: { has_more: false, data: [{ price: { id: PRO } }] } };
    const stripe = { subscriptions: { list: (params: { customer: string }) => {
      calls.push(params.customer);
      return (async function* () { yield subscription; })();
    } } };
    const read = createStripeReader(stripe as unknown as import('stripe').Stripe);
    expect(await read('cus_user')).toEqual([{ id: 'sub_user', ...liveSub() }]);
    expect(calls).toEqual(['cus_user']);
    subscription.items.has_more = true;
    await expect(read('cus_user')).rejects.toThrow('Incomplete subscription items');
  });
});
