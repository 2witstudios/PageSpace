#!/usr/bin/env bun
/**
 * D-OW-42 supersedes D-OW-19: verify the Stripe switch BEFORE normalizing a
 * retired Founder tier. Runtime price aliases and Business grandfathering are
 * forbidden. This tool never writes Stripe, wallets, credits, or billing prices.
 *
 * Sequence: complete the explicit Stripe move to the configured Pro price,
 * deliver its webhook, run this preflight, then --apply before deploying the
 * strict runtime. Scheduled future switches are NOT completed migrations.
 * Unresolved personal Business subscribers block rollout pending their explicit
 * organization migration. Every unresolved row causes a nonzero CLI exit and
 * prevents ALL database writes. Dry-run is the default; apply is idempotent.
 */
import { pathToFileURL } from 'node:url';
import { and, eq, inArray, or } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { subscriptions } from '@pagespace/db/schema/subscriptions';

export interface MigrationUser {
  id: string;
  tier: string;
  grandfathered: boolean;
  customerId: string | null;
  subscriptions: { id: string; priceId: string; status: string }[];
}
export interface LiveSubscription {
  customerId: string;
  status: string;
  priceIds: string[];
  scheduled: boolean;
}
export interface MigrationUpdate { user: MigrationUser; tier: 'free' | 'pro' }
export interface MigrationDeps {
  listCandidates(): Promise<MigrationUser[]>;
  readSubscription(id: string): Promise<LiveSubscription>;
  /** Atomically compare every observed user/mirror row and apply all updates. */
  apply(updates: readonly MigrationUpdate[]): Promise<void>;
  proPriceId: string;
}
export function parseMode(argv: readonly string[]): { apply: boolean } {
  if (argv.some((arg) => arg !== '--apply' && arg !== '--dry-run')) throw new Error('Unknown argument');
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('Pass either --apply or --dry-run');
  return { apply: argv.includes('--apply') };
}

/** Only ended subscriptions can remain on retired prices after the cutover. */
const ended = (status: string) => status === 'canceled' || status === 'incomplete_expired';

export function planFounderCutover(user: MigrationUser, live: ReadonlyMap<string, LiveSubscription>, proPriceId: string): {
  update?: MigrationUpdate; issues: string[];
} {
  const issues: string[] = [];
  if (!proPriceId) return { issues: ['Configured Pro price is required'] };
  if (user.tier === 'business' || user.grandfathered) {
    issues.push(`${user.id}: personal Business requires its explicit organization migration`);
  }
  let tier: 'free' | 'pro' = 'free';
  for (const row of user.subscriptions) {
    const current = live.get(row.id);
    if (!current) { issues.push(`${user.id}/${row.id}: Stripe verification failed`); continue; }
    if (!user.customerId || current.customerId !== user.customerId) issues.push(`${user.id}/${row.id}: customer mismatch`);
    if (current.scheduled) issues.push(`${user.id}/${row.id}: scheduled switch is not a completed migration`);
    if (current.status !== row.status || current.priceIds.length !== 1 || current.priceIds[0] !== row.priceId) {
      issues.push(`${user.id}/${row.id}: mirror differs from Stripe; synchronize before applying`);
    }
    if (!ended(current.status) && (current.priceIds.length !== 1 || current.priceIds[0] !== proPriceId)) {
      issues.push(`${user.id}/${row.id}: switch to the configured Pro price before rollout`);
    }
    if (current.priceIds.length === 1 && current.priceIds[0] === proPriceId && ['active', 'trialing'].includes(current.status)) tier = 'pro';
  }
  if (user.tier === 'founder' && user.subscriptions.length === 0) issues.push(`${user.id}: Founder has no subscription evidence`);
  return { issues, ...(issues.length === 0 && user.tier === 'founder' ? { update: { user, tier } } : {}) };
}

export async function runFounderMigration(deps: MigrationDeps, options: { apply: boolean }) {
  if (!deps.proPriceId) throw new Error('Configured Pro price is required');
  const candidates = await deps.listCandidates();
  const live = new Map<string, LiveSubscription>();
  for (const id of new Set(candidates.flatMap((user) => user.subscriptions.map((row) => row.id)))) {
    try { live.set(id, await deps.readSubscription(id)); }
    catch { /* Missing evidence is reported by the pure planner and blocks every write. */ }
  }
  const plans = candidates.map((user) => planFounderCutover(user, live, deps.proPriceId));
  const issues = plans.flatMap((plan) => plan.issues);
  const updates = plans.flatMap((plan) => plan.update ? [plan.update] : []);
  if (options.apply && issues.length === 0 && updates.length > 0) await deps.apply(updates);
  return { ready: issues.length === 0, apply: options.apply, scanned: candidates.length, normalized: issues.length === 0 ? updates.length : 0, issues };
}

function fingerprint(user: MigrationUser): string {
  return JSON.stringify({ ...user, subscriptions: [...user.subscriptions].sort((a, b) => a.id.localeCompare(b.id)) });
}

type MigrationDb = typeof import('@pagespace/db/db').db;
export function createMigrationStore(db: MigrationDb, retiredPriceIds: readonly string[]) {
  async function readUsers(ids: string[], source: MigrationDb | Parameters<Parameters<MigrationDb['transaction']>[0]>[0], lock = false): Promise<MigrationUser[]> {
    const query = source.select({ id: users.id, tier: users.subscriptionTier, grandfathered: users.subscriptionGrandfathered, customerId: users.stripeCustomerId })
      .from(users).where(inArray(users.id, ids)).orderBy(users.id);
    const people = await (lock ? query.for('update') : query);
    const subQuery = source.select({ userId: subscriptions.userId, id: subscriptions.stripeSubscriptionId, priceId: subscriptions.stripePriceId, status: subscriptions.status })
      .from(subscriptions).where(inArray(subscriptions.userId, ids)).orderBy(subscriptions.stripeSubscriptionId);
    const rows = await (lock ? subQuery.for('update') : subQuery);
    return people.map((user) => ({ ...user, subscriptions: rows.filter((row) => row.userId === user.id).map(({ id, priceId, status }) => ({ id, priceId, status })) }));
  }
  return {
    async listCandidates(): Promise<MigrationUser[]> {
      const rows = await db.select({ id: users.id }).from(users).leftJoin(subscriptions, eq(subscriptions.userId, users.id))
        .where(or(inArray(users.subscriptionTier, ['founder', 'business']), eq(users.subscriptionGrandfathered, true), inArray(subscriptions.stripePriceId, [...retiredPriceIds])));
      const ids = [...new Set(rows.map((row) => row.id))];
      return ids.length ? readUsers(ids, db) : [];
    },
    async apply(updates: readonly MigrationUpdate[]): Promise<void> {
      await db.transaction(async (tx) => {
        const current = await readUsers(updates.map(({ user }) => user.id), tx, true);
        for (const update of updates) {
          const actual = current.find((user) => user.id === update.user.id);
          if (!actual || fingerprint(actual) !== fingerprint(update.user)) throw new Error(`Migration evidence changed for ${update.user.id}; rerun preflight`);
        }
        for (const { user, tier } of updates) await tx.update(users).set({ subscriptionTier: tier, updatedAt: new Date() })
          .where(and(eq(users.id, user.id), eq(users.subscriptionTier, 'founder')));
      });
    },
  };
}

export function createStripeReader(stripe: import('stripe').Stripe): MigrationDeps['readSubscription'] {
  return async (id) => {
    const sub = await stripe.subscriptions.retrieve(id);
    if (sub.items.has_more) throw new Error('Incomplete subscription items');
    return { customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id, status: sub.status,
      priceIds: sub.items.data.map((item) => item.price.id), scheduled: sub.schedule !== null };
  };
}

async function main() {
  const options = parseMode(process.argv.slice(2));
  const { stripeConfig } = await import('../apps/web/src/lib/stripe-config');
  const { getPersonalTierFromPrice } = await import('../apps/web/src/lib/stripe/price-config');
  if (getPersonalTierFromPrice(stripeConfig.priceIds.pro) !== 'pro') throw new Error('Pro price configuration is missing or ambiguous');
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is required for verification');
  const { stripe } = await import('../apps/web/src/lib/stripe/client');
  const { getMigrationDb } = await import('@pagespace/db/db');
  const result = await runFounderMigration({
    ...createMigrationStore(getMigrationDb(), Object.values(stripeConfig.grandfatheredPriceIds)),
    readSubscription: createStripeReader(stripe), proPriceId: stripeConfig.priceIds.pro,
  }, options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) throw new Error('Cutover blocked: resolve every reported subscriber before rollout');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}
