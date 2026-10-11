import { describe, expect, it } from 'vitest';
import { createStripeReader, parseMode, planFounderCutover, runFounderMigration, type LiveSubscription, type MigrationDeps, type MigrationUser } from '../migrate-founder-to-pro';

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
    listCandidates: async () => people.filter((user) => user.tier === 'founder' || user.tier === 'business' || user.grandfathered),
    readSubscription: async (id) => { reads.push(id); return live; },
    apply: async (updates) => {
      for (const { user, tier } of updates) { writes.push(user.id); user.tier = tier; }
    },
  };
  return { deps, writes, reads, people };
}

describe('D-OW-42 Founder cutover preflight', () => {
  it('defaults to dry-run and rejects contradictory or unknown arguments', () => {
    expect(parseMode([])).toEqual({ apply: false });
    expect(parseMode(['--dry-run'])).toEqual({ apply: false });
    expect(parseMode(['--apply'])).toEqual({ apply: true });
    expect(() => parseMode(['--apply', '--dry-run'])).toThrow();
    expect(() => parseMode(['--force'])).toThrow();
  });
  it('requires the Stripe switch and matching mirror before normalizing; dry-run writes nothing', async () => {
    const h = harness();
    expect(await runFounderMigration(h.deps, { apply: false })).toMatchObject({ ready: true, normalized: 1 });
    expect(h.writes).toEqual([]);
    expect(h.people[0].tier).toBe('founder');
    expect(h.reads).toEqual(['sub_user']);
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
    h.deps.readSubscription = async () => { throw new Error('unavailable'); };
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
  it('the Stripe adapter is read-only and refuses truncated item evidence', async () => {
    const calls: string[] = [];
    const subscription = { customer: 'cus_user', status: 'active', schedule: null, items: { has_more: false, data: [{ price: { id: PRO } }] } };
    const stripe = { subscriptions: { retrieve: async (id: string) => { calls.push(id); return subscription; } } };
    const read = createStripeReader(stripe as unknown as import('stripe').Stripe);
    expect(await read('sub_user')).toEqual(liveSub());
    expect(calls).toEqual(['sub_user']);
    subscription.items.has_more = true;
    await expect(read('sub_user')).rejects.toThrow('Incomplete subscription items');
  });
});
