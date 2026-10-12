#!/usr/bin/env bun
/**
 * D-OW-42 supersedes D-OW-19: verify the Stripe switch BEFORE normalizing a
 * retired Founder tier. Runtime price aliases and Business grandfathering are
 * forbidden. This tool never writes Stripe, wallets, credits, or billing prices.
 *
 * Sequence: complete the explicit Stripe move to the configured Pro price,
 * deliver its webhook, run this preflight, then --apply before deploying the
 * strict runtime. Scheduled future switches are NOT completed migrations.
 * Personal Business requires an explicit Free/Pro destination manifest and
 * matching live evidence. Every unresolved row causes a nonzero CLI exit and
 * prevents ALL database writes. Dry-run is the default; apply is idempotent.
 */
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { z } from 'zod/v4';
import { personalTiers, type PersonalSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { and, eq, inArray, isNotNull, or, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { classifySubscriptionKind } from '@pagespace/lib/services/app-hosting/dedicated-tier';

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
  readCustomerSubscriptions(customerId: string): Promise<ReadonlyArray<LiveSubscription & { id: string }>>;
  /** Atomically compare every observed user/mirror row and apply all updates. */
  apply(updates: readonly MigrationUpdate[], observed: readonly MigrationUser[]): Promise<void>;
  proPriceId: string;
  businessDestinations?: ReadonlyMap<string, PersonalSubscriptionTier>;
  billingEnabled?: boolean;
}
export function parseMode(argv: readonly string[]): { apply: boolean; businessManifest?: string } {
  let businessManifest: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--business-manifest') {
      const path = argv[++index];
      if (businessManifest || !path || path.startsWith('--')) throw new Error('Provide exactly one manifest path');
      businessManifest = path;
    } else if (arg !== '--apply' && arg !== '--dry-run') throw new Error('Unknown argument');
  }
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('Pass either --apply or --dry-run');
  return { apply: argv.includes('--apply'), ...(businessManifest ? { businessManifest } : {}) };
}

export function parseBusinessManifest(value: unknown): ReadonlyMap<string, PersonalSubscriptionTier> {
  const manifest = z.object({
    version: z.literal(1),
    users: z.array(z.object({ userId: z.string().min(1), tier: z.enum(personalTiers()) }).strict()),
  }).strict().parse(value);
  const destinations = new Map<string, PersonalSubscriptionTier>();
  for (const user of manifest.users) {
    if (destinations.has(user.userId)) throw new Error(`Duplicate manifest user: ${user.userId}`);
    destinations.set(user.userId, user.tier);
  }
  return destinations;
}

/** Only ended subscriptions can remain on retired prices after the cutover. */
const ended = (status: string) => status === 'canceled' || status === 'incomplete_expired';

export function planFounderCutover(user: MigrationUser, live: ReadonlyMap<string, LiveSubscription>, proPriceId: string, businessDestination?: PersonalSubscriptionTier): {
  update?: MigrationUpdate; issues: string[];
} {
  const issues: string[] = [];
  if (!proPriceId) return { issues: ['Configured Pro price is required'] };
  if ((user.tier === 'business' || user.grandfathered) && !businessDestination) {
    issues.push(`${user.id}: personal Business requires an explicit destination manifest`);
  }
  for (const [id, current] of live) {
    if (current.customerId === user.customerId && !ended(current.status) && !user.subscriptions.some((row) => row.id === id)) {
      issues.push(`${user.id}/${id}: active Stripe subscription is missing from the mirror`);
    }
  }
  let tier: 'free' | 'pro' = 'free';
  for (const row of user.subscriptions) {
    const current = live.get(row.id);
    if (!current) { issues.push(`${user.id}/${row.id}: Stripe verification failed`); continue; }
    if (!user.customerId || current.customerId !== user.customerId) issues.push(`${user.id}/${row.id}: customer mismatch`);
    if (current.scheduled) issues.push(`${user.id}/${row.id}: scheduled switch is not a completed migration`);
    if (businessDestination === 'free' && !ended(current.status)) issues.push(`${user.id}/${row.id}: Free requires every personal subscription to have ended`);
    if (current.status !== row.status || current.priceIds.length !== 1 || current.priceIds[0] !== row.priceId) {
      issues.push(`${user.id}/${row.id}: mirror differs from Stripe; synchronize before applying`);
    }
    if (!ended(current.status) && (current.priceIds.length !== 1 || current.priceIds[0] !== proPriceId)) {
      issues.push(`${user.id}/${row.id}: switch to the configured Pro price before rollout`);
    }
    if (current.priceIds.length === 1 && current.priceIds[0] === proPriceId && ['active', 'trialing'].includes(current.status)) tier = 'pro';
  }
  if ((['founder', 'business'].includes(user.tier) || user.grandfathered) && user.subscriptions.length === 0) issues.push(`${user.id}: retired tier has no subscription evidence`);
  if (businessDestination && businessDestination !== tier) issues.push(`${user.id}: manifest destination differs from verified Stripe entitlement`);
  return { issues, ...(issues.length === 0 && (user.tier !== tier || user.grandfathered) ? { update: { user, tier } } : {}) };
}

export async function runFounderMigration(deps: MigrationDeps, options: { apply: boolean }) {
  const candidates = await deps.listCandidates();
  if (deps.billingEnabled === false) {
    const issues = candidates.filter((user) => user.customerId || user.subscriptions.length > 0)
      .map((user) => `${user.id}: Stripe evidence exists on a billing-disabled deployment; verify it before normalization`);
    const updates: MigrationUpdate[] = candidates.filter((user) => user.tier !== 'free' || user.grandfathered)
      .map((user) => ({ user, tier: 'free' }));
    if (options.apply && issues.length === 0 && updates.length > 0) await deps.apply(updates);
    return { ready: issues.length === 0, apply: options.apply, scanned: candidates.length, normalized: issues.length === 0 ? updates.length : 0, issues };
  }
  if (!deps.proPriceId) throw new Error('Configured Pro price is required');
  const live = new Map<string, LiveSubscription>();
  const readFailures: string[] = [];
  for (const customerId of new Set(candidates.flatMap((user) => user.customerId ? [user.customerId] : []))) {
    try {
      const rows = await deps.readCustomerSubscriptions(customerId);
      if (rows.some((row) => row.customerId !== customerId)) throw new Error('Customer mismatch');
      for (const row of rows) live.set(row.id, row);
    } catch {
      readFailures.push(`${customerId}: complete Stripe subscription verification failed`);
    }
  }
  const plans = candidates.map((user) => planFounderCutover(user, live, deps.proPriceId, deps.businessDestinations?.get(user.id)));
  const unknownManifestUsers = [...(deps.businessDestinations?.keys() ?? [])].filter((id) => !candidates.some((user) => user.id === id));
  const issues = [...readFailures, ...unknownManifestUsers.map((id) => `${id}: manifest user is not in the billing inventory`), ...plans.flatMap((plan) => plan.issues)];
  const updates = plans.flatMap((plan) => plan.update ? [plan.update] : []);
  if (options.apply && issues.length === 0) await deps.apply(updates, candidates);
  return { ready: issues.length === 0, apply: options.apply, scanned: candidates.length, normalized: issues.length === 0 ? updates.length : 0, issues };
}

function fingerprint(user: MigrationUser): string {
  return JSON.stringify({ ...user, subscriptions: [...user.subscriptions].sort((a, b) => a.id.localeCompare(b.id)) });
}

type MigrationDb = typeof import('@pagespace/db/db').db;
export function createMigrationStore(db: MigrationDb) {
  // The pre-cutover inventory must still be readable after the column is dropped,
  // so rerunning the one-time verifier is an idempotent no-op on the final schema.
  const grandfathered = sql<boolean>`coalesce((to_jsonb(${users})->>'subscriptionGrandfathered')::boolean, false)`;
  async function readUsers(ids: string[], source: MigrationDb | Parameters<Parameters<MigrationDb['transaction']>[0]>[0], lock = false): Promise<MigrationUser[]> {
    const query = source.select({ id: users.id, tier: users.subscriptionTier, grandfathered, customerId: users.stripeCustomerId })
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
        // Stable population: webhook tier/price changes cannot remove a billing customer.
        .where(or(isNotNull(users.stripeCustomerId), isNotNull(subscriptions.stripeSubscriptionId),
          inArray(users.subscriptionTier, ['founder', 'business']), grandfathered));
      const ids = [...new Set(rows.map((row) => row.id))];
      return ids.length ? readUsers(ids, db) : [];
    },
    async apply(updates: readonly MigrationUpdate[], observed: readonly MigrationUser[]): Promise<void> {
      await db.transaction(async (tx) => {
        const current = observed.length ? await readUsers(observed.map((user) => user.id), tx, true) : [];
        for (const expected of observed) {
          const actual = current.find((user) => user.id === expected.id);
          if (!actual || fingerprint(actual) !== fingerprint(expected)) throw new Error(`Migration evidence changed for ${expected.id}; rerun preflight`);
        }
        const columns = await tx.execute(sql`SELECT 1 FROM pg_attribute WHERE attrelid = 'users'::regclass
          AND attname = 'subscriptionGrandfathered' AND NOT attisdropped`);
        for (const { user, tier } of updates) {
          await tx.update(users).set({ subscriptionTier: tier, updatedAt: new Date() })
            .where(and(eq(users.id, user.id), eq(users.subscriptionTier, user.tier)));
          if (columns.rows.length > 0) await tx.execute(sql`UPDATE ${users} SET "subscriptionGrandfathered" = false WHERE ${users.id} = ${user.id}`);
        }
      });
    },
  };
}

export function createStripeReader(stripe: import('stripe').Stripe): MigrationDeps['readCustomerSubscriptions'] {
  return async (customerId) => {
    const rows: Array<LiveSubscription & { id: string }> = [];
    for await (const sub of stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })) {
      // The same discriminator as runtime: hosting is not a personal plan.
      if (classifySubscriptionKind(sub.metadata) === 'published_app_dedicated') continue;
      if (sub.items.has_more) throw new Error('Incomplete subscription items');
      rows.push({ id: sub.id, customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
        status: sub.status, priceIds: sub.items.data.map((item) => item.price.id), scheduled: sub.schedule !== null });
    }
    return rows;
  };
}

async function main() {
  const options = parseMode(process.argv.slice(2));
  const businessDestinations = options.businessManifest
    ? parseBusinessManifest(JSON.parse(await readFile(options.businessManifest, 'utf8')))
    : undefined;
  const { isBillingEnabled } = await import('@pagespace/lib/deployment-mode');
  const { getMigrationDb } = await import('@pagespace/db/db');
  if (!isBillingEnabled()) {
    const result = await runFounderMigration({ ...createMigrationStore(getMigrationDb()), proPriceId: '', billingEnabled: false,
      readCustomerSubscriptions: async () => { throw new Error('Stripe is disabled'); },
    }, options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) throw new Error('Cutover blocked: resolve Stripe evidence before rollout');
    return;
  }
  const { stripeConfig } = await import('../apps/web/src/lib/stripe-config');
  const { getPersonalTierFromPrice } = await import('../apps/web/src/lib/stripe/price-config');
  if (getPersonalTierFromPrice(stripeConfig.priceIds.pro) !== 'pro') throw new Error('Pro price configuration is missing or ambiguous');
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is required for verification');
  const { stripe } = await import('../apps/web/src/lib/stripe/client');
  const result = await runFounderMigration({
    ...createMigrationStore(getMigrationDb()),
    readCustomerSubscriptions: createStripeReader(stripe), proPriceId: stripeConfig.priceIds.pro,
    businessDestinations,
  }, options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) throw new Error('Cutover blocked: resolve every reported subscriber before rollout');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}
