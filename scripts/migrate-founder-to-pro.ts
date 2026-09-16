#!/usr/bin/env bun
/**
 * One-shot migration for A-9 (Organizations & Wallets, SEAT-2): the Founder
 * tier is removed from the vocabulary. DATABASE-ONLY — see [D-OW-19].
 *
 * Moving the Founder subscription to the Pro price is a MANUAL Stripe
 * dashboard step on migration day (schedule the switch at period end), not
 * code: five review rounds kept finding real P1s in an automated schedule
 * write for what is a single subscription. It is safe to leave to the
 * dashboard because price-config maps the grandfathered Founder price to
 * 'pro', and the webhook re-derives the tier with getTierFromPrice on
 * customer.subscription.updated when the schedule switches the price.
 *
 * This script:
 *   1. REPORTS every subscription on the Founder price — user, status,
 *      current period end, schedule presence — read from Stripe, so the
 *      dashboard step is checked against real data. It never writes Stripe.
 *   2. NORMALIZES a stored `users.subscriptionTier = 'founder'` to the tier
 *      derived from the user's subscription price (getTierFromPrice → 'pro').
 *      'founder' is outside the vocabulary, and toSubscriptionTier coerces it
 *      to 'free' at every read site.
 *   3. MARKS every subscriber on the legacy $100 personal Business price
 *      `users.subscriptionGrandfathered = true`: Business entitlements at the
 *      price they already pay. A flag, not a tier.
 *
 * Idempotent: a normalized tier is no longer 'founder' and a flagged user is
 * skipped, so a second run writes nothing.
 *
 * Usage:
 *   bun scripts/migrate-founder-to-pro.ts            # dry run (default), no writes
 *   bun scripts/migrate-founder-to-pro.ts --apply    # write steps 2 and 3
 *
 * Env: DATABASE_URL, STRIPE_SECRET_KEY (live or test to match stripe-config).
 */
import { pathToFileURL } from 'node:url';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { ENTITLED_SUBSCRIPTION_STATUSES } from '@pagespace/lib/billing/subscription-tier-sync';

// ─── Seams ───────────────────────────────────────────────────────────────────

/** A subscription row on the retired Founder price. */
export interface FounderPriceSubscriptionRow {
  userId: string;
  stripeSubscriptionId: string;
  status: string;
}

/** A user whose stored tier is still the removed 'founder'. */
export interface FounderTierUserRow {
  userId: string;
  /** Price of the user's subscription, or null when they have none. */
  stripePriceId: string | null;
}

/** A user on the legacy $100 personal Business price. */
export interface LegacyBusinessRow {
  userId: string;
  subscriptionGrandfathered: boolean;
}

/** What the script reads and writes in Postgres. */
export interface MigrationStore {
  listFounderPriceSubscriptions(): Promise<FounderPriceSubscriptionRow[]>;
  listFounderTierUsers(): Promise<FounderTierUserRow[]>;
  /** Set the tier only while it still reads 'founder'. */
  normalizeFounderTier(userId: string, tier: string): Promise<void>;
  listLegacyBusinessSubscribers(): Promise<LegacyBusinessRow[]>;
  markGrandfathered(userId: string): Promise<void>;
}

/** The live Stripe facts the report shows. */
export interface StripeSubscriptionFacts {
  status: string;
  /** Unix seconds; item-level period end (API 2025-08-27+). */
  currentPeriodEnd: number;
  scheduleId: string | null;
}

/** Read-only: the only thing the script asks of Stripe. */
export interface StripeSubscriptionReader {
  retrieveSubscription(id: string): Promise<StripeSubscriptionFacts>;
}

export interface MigrationDeps {
  store: MigrationStore;
  stripe: StripeSubscriptionReader;
  /** getTierFromPrice from apps/web/src/lib/stripe/price-config.ts. */
  deriveTier: (priceId: string) => string;
  log: (line: string) => void;
}

export interface FounderReportEntry {
  userId: string;
  stripeSubscriptionId: string;
  status: string;
  currentPeriodEnd: string;
  scheduleId: string | null;
}

export interface MigrationSummary {
  apply: boolean;
  report: FounderReportEntry[];
  reportFailed: number;
  normalized: number;
  founderTierUnresolved: number;
  legacyBusinessRows: number;
  grandfathered: number;
  alreadyGrandfathered: number;
}

/** Dry run unless `--apply`; both flags together is ambiguous and refused. */
export function parseMode(argv: readonly string[]): { apply: boolean } {
  const apply = argv.includes('--apply');
  if (apply && argv.includes('--dry-run')) throw new Error('Pass either --apply or --dry-run, not both');
  return { apply };
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export async function runFounderMigration(deps: MigrationDeps, opts: { apply: boolean }): Promise<MigrationSummary> {
  const { store, stripe, deriveTier, log } = deps;
  const summary: MigrationSummary = {
    apply: opts.apply,
    report: [],
    reportFailed: 0,
    normalized: 0,
    founderTierUnresolved: 0,
    legacyBusinessRows: 0,
    grandfathered: 0,
    alreadyGrandfathered: 0,
  };
  const mode = opts.apply ? '' : '[dry-run] ';

  // 1. Read-only report of the Founder-price subscriptions.
  const founderSubs = await store.listFounderPriceSubscriptions();
  log(`${mode}${founderSubs.length} subscription(s) on the Founder price (move each to Pro in the Stripe dashboard):`);
  for (const row of founderSubs) {
    try {
      const live = await stripe.retrieveSubscription(row.stripeSubscriptionId);
      const entry: FounderReportEntry = {
        userId: row.userId,
        stripeSubscriptionId: row.stripeSubscriptionId,
        status: live.status,
        currentPeriodEnd: new Date(live.currentPeriodEnd * 1000).toISOString(),
        scheduleId: live.scheduleId,
      };
      summary.report.push(entry);
      log(
        `${mode}  ${entry.userId}: ${entry.stripeSubscriptionId} status ${entry.status}, period ends ${entry.currentPeriodEnd}, ` +
          (entry.scheduleId ? `schedule ${entry.scheduleId}` : 'no schedule'),
      );
    } catch (err) {
      summary.reportFailed++;
      log(`${mode}  ${row.userId}: ${row.stripeSubscriptionId} Stripe read FAILED (db status ${row.status}): ${String(err)}`);
    }
  }

  // 2. Normalize a stored 'founder' tier to its derived tier.
  const founderTierUsers = await store.listFounderTierUsers();
  log(`${mode}${founderTierUsers.length} user(s) with subscriptionTier 'founder'`);
  for (const row of founderTierUsers) {
    if (!row.stripePriceId) {
      summary.founderTierUnresolved++;
      log(`${mode}  ${row.userId}: no subscription price to derive a tier from — left for review`);
      continue;
    }
    const tier = deriveTier(row.stripePriceId);
    summary.normalized++;
    log(`${mode}  ${row.userId}: users.subscriptionTier founder → ${tier} (price ${row.stripePriceId})`);
    if (opts.apply) await store.normalizeFounderTier(row.userId, tier);
  }

  // 3. Grandfather the legacy $100 personal Business subscribers.
  const legacyRows = await store.listLegacyBusinessSubscribers();
  summary.legacyBusinessRows = legacyRows.length;
  log(`${mode}${legacyRows.length} subscriber(s) on the legacy $100 personal Business price`);
  for (const row of legacyRows) {
    if (row.subscriptionGrandfathered) {
      summary.alreadyGrandfathered++;
      log(`${mode}  ${row.userId}: already grandfathered — skipped`);
      continue;
    }
    summary.grandfathered++;
    log(`${mode}  ${row.userId}: users.subscriptionGrandfathered → true`);
    if (opts.apply) await store.markGrandfathered(row.userId);
  }

  log(
    `${mode}Summary: founder-price subscriptions ${founderSubs.length} (reported ${summary.report.length}, read failed ${summary.reportFailed}); ` +
      `founder tiers normalized ${summary.normalized} (unresolved ${summary.founderTierUnresolved}); ` +
      `legacy business rows ${summary.legacyBusinessRows} (grandfathered ${summary.grandfathered}, already ${summary.alreadyGrandfathered})`,
  );
  return summary;
}

// ─── Real adapters (IO at the edges) ─────────────────────────────────────────

/** The drizzle surface the store uses; typed narrowly so the runner never sees the ORM. */
type MigrationDb = typeof import('@pagespace/db/db').db;

export function createDrizzleStore(db: MigrationDb, priceIds: { founder: string; legacyBusiness: string }): MigrationStore {
  const entitled = [...ENTITLED_SUBSCRIPTION_STATUSES, 'past_due'];
  return {
    async listFounderPriceSubscriptions() {
      return db
        .select({
          userId: subscriptions.userId,
          stripeSubscriptionId: subscriptions.stripeSubscriptionId,
          status: subscriptions.status,
        })
        .from(subscriptions)
        .where(eq(subscriptions.stripePriceId, priceIds.founder));
    },
    async listFounderTierUsers() {
      const rows = await db
        .select({ userId: users.id, stripePriceId: subscriptions.stripePriceId, status: subscriptions.status })
        .from(users)
        .leftJoin(subscriptions, eq(subscriptions.userId, users.id))
        .where(eq(users.subscriptionTier, 'founder'));
      // One row per user: prefer an entitled subscription's price over a lapsed one.
      const byUser = new Map<string, FounderTierUserRow>();
      for (const row of rows) {
        const current = byUser.get(row.userId);
        if (!current || (row.status !== null && entitled.includes(row.status))) {
          byUser.set(row.userId, { userId: row.userId, stripePriceId: row.stripePriceId });
        }
      }
      return [...byUser.values()];
    },
    async normalizeFounderTier(userId, tier) {
      await db
        .update(users)
        .set({ subscriptionTier: tier })
        .where(and(eq(users.id, userId), eq(users.subscriptionTier, 'founder')));
    },
    async listLegacyBusinessSubscribers() {
      return db
        .select({ userId: users.id, subscriptionGrandfathered: users.subscriptionGrandfathered })
        .from(subscriptions)
        .innerJoin(users, eq(users.id, subscriptions.userId))
        .where(and(eq(subscriptions.stripePriceId, priceIds.legacyBusiness), inArray(subscriptions.status, entitled)));
    },
    async markGrandfathered(userId) {
      await db.update(users).set({ subscriptionGrandfathered: true }).where(eq(users.id, userId));
    },
  };
}

/** Read-only Stripe adapter: `subscriptions.retrieve` and nothing else. */
export function createStripeReader(stripe: import('stripe').Stripe): StripeSubscriptionReader {
  return {
    async retrieveSubscription(id) {
      const sub = await stripe.subscriptions.retrieve(id);
      const firstItem = sub.items.data[0];
      if (!firstItem) throw new Error(`Subscription ${id} has no items`);
      // Item-level period end (Stripe API 2025-08-27+), as the webhook reads it.
      const item = firstItem as typeof firstItem & { current_period_end?: number };
      if (typeof item.current_period_end !== 'number') throw new Error(`Subscription ${id}: item has no current_period_end`);
      return {
        status: sub.status,
        currentPeriodEnd: item.current_period_end,
        scheduleId: sub.schedule == null ? null : typeof sub.schedule === 'string' ? sub.schedule : sub.schedule.id,
      };
    },
  };
}

async function main(): Promise<void> {
  const { apply } = parseMode(process.argv.slice(2));
  // Price ids come from the web app's hardcoded Stripe config (test vs live
  // follows NODE_ENV / NEXT_PUBLIC_STRIPE_MODE exactly as the app does).
  const { stripeConfig, stripeMode } = await import('../apps/web/src/lib/stripe-config');
  const { stripe } = await import('../apps/web/src/lib/stripe/client');
  const { getTierFromPrice } = await import('../apps/web/src/lib/stripe/price-config');
  const { getMigrationDb } = await import('@pagespace/db/db');
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is required to read the Founder-price subscriptions (read-only)');
  }
  console.log(`Stripe mode: ${stripeMode}${apply ? ' (--apply: database writes)' : ' (dry run — no writes; pass --apply to write)'}`);
  const summary = await runFounderMigration(
    {
      store: createDrizzleStore(getMigrationDb(), {
        founder: stripeConfig.grandfatheredPriceIds.founder,
        legacyBusiness: stripeConfig.priceIds.business,
      }),
      stripe: createStripeReader(stripe),
      deriveTier: (priceId) => getTierFromPrice(priceId),
      log: (line) => console.log(line),
    },
    { apply },
  );
  if (summary.report.length + summary.reportFailed > 1) {
    console.warn(`Expected a single Founder subscriber (A-9) but found ${summary.report.length + summary.reportFailed}; review the rows above.`);
  }
  if (summary.reportFailed > 0 || summary.founderTierUnresolved > 0) {
    console.warn('Some rows need review — see the FAILED / "left for review" lines above.');
  }
}

// Portable entry guard (import.meta.main is bun-only and not in @types/node).
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
