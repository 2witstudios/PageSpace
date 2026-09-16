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
 *      its subscriptions derive (deriveTierFromSubscriptions + getTierFromPrice
 *      → 'pro'), the webhook's own rule: only an active/trialing row counts,
 *      and only a determinate paid tier is written. Anyone else (canceled,
 *      past_due, unmapped price, no subscription) is left for review — they
 *      already read as Free, since toSubscriptionTier coerces 'founder' to it.
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
import type { SubscriptionTier as SubscriptionTierName } from '@pagespace/lib/billing/subscription-tiers';
import { and, asc, desc, eq, or } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import {
  ENTITLED_SUBSCRIPTION_STATUSES,
  deriveTierFromSubscriptions,
  type PriceTierResolver,
  type SubscriptionRowLike,
} from '@pagespace/lib/billing/subscription-tier-sync';

// ─── Seams ───────────────────────────────────────────────────────────────────

/** A subscription row on the retired Founder price. */
export interface FounderPriceSubscriptionRow {
  userId: string;
  stripeSubscriptionId: string;
  status: string;
}

/** A user whose stored tier is still the removed 'founder', with every subscription row they have. */
export interface FounderTierUserRow {
  userId: string;
  subscriptions: SubscriptionRowLike[];
}

/** A user on the legacy $100 personal Business price. */
export interface LegacyBusinessRow {
  userId: string;
  subscriptionGrandfathered: boolean;
}

/**
 * One user ⟕ subscription row as the store reads it, before any selection
 * rule applies (subscription fields are null for a user with none).
 */
export interface SubscribedUserCandidate {
  userId: string;
  subscriptionTier: string;
  subscriptionGrandfathered: boolean;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  status: string | null;
  updatedAt: Date | null;
}

/** What the script reads and writes in Postgres. */
export interface MigrationStore {
  listFounderPriceSubscriptions(): Promise<FounderPriceSubscriptionRow[]>;
  listFounderTierUsers(): Promise<FounderTierUserRow[]>;
  /** Set the tier only while it still reads 'founder'. */
  normalizeFounderTier(userId: string, tier: Exclude<SubscriptionTierName, 'free'>): Promise<void>;
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
  deriveTier: PriceTierResolver;
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

/**
 * The price ids the script selects on. The legacy $100 personal Business id
 * is read from `grandfatheredPriceIds`, never `priceIds.business`: that one is
 * whatever Business sells today, and becomes the $50 org price in Wave C.
 */
export function migrationPriceIds(config: {
  grandfatheredPriceIds: { founder: string; legacyBusiness: string };
}): { founder: string; legacyBusiness: string } {
  return { founder: config.grandfatheredPriceIds.founder, legacyBusiness: config.grandfatheredPriceIds.legacyBusiness };
}

// ─── Pure row selection ──────────────────────────────────────────────────────

/**
 * Statuses that keep a legacy $100 Business subscriber's grandfathering: the
 * webhook's entitled statuses plus past_due, so a failed card retry does not
 * cost them the price they already pay. Tier derivation does NOT use this —
 * it uses deriveTierFromSubscriptions (webhook parity).
 */
const GRANDFATHER_STATUSES: readonly string[] = [...ENTITLED_SUBSCRIPTION_STATUSES, 'past_due'];

/** Input order: by user, most recently updated subscription first, then subscription id. */
function byUserThenRecency(a: SubscribedUserCandidate, b: SubscribedUserCandidate): number {
  if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1;
  const diff = (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0);
  if (diff !== 0) return diff;
  return (a.stripeSubscriptionId ?? '').localeCompare(b.stripeSubscriptionId ?? '');
}

function sorted(rows: readonly SubscribedUserCandidate[]): SubscribedUserCandidate[] {
  return [...rows].sort(byUserThenRecency);
}

/** Every subscription on the Founder price, whatever its status (the report shows it). */
export function selectFounderPriceSubscriptions(
  rows: readonly SubscribedUserCandidate[],
  founderPriceId: string,
): FounderPriceSubscriptionRow[] {
  return sorted(rows).flatMap((row) =>
    row.stripePriceId === founderPriceId && row.stripeSubscriptionId !== null && row.status !== null
      ? [{ userId: row.userId, stripeSubscriptionId: row.stripeSubscriptionId, status: row.status }]
      : [],
  );
}

/** Users whose stored tier is 'founder', each with ALL their subscription rows (any status). */
export function selectFounderTierUsers(rows: readonly SubscribedUserCandidate[]): FounderTierUserRow[] {
  const byUser = new Map<string, SubscriptionRowLike[]>();
  for (const row of sorted(rows)) {
    if (row.subscriptionTier !== 'founder') continue;
    const subs = byUser.get(row.userId) ?? [];
    if (row.stripePriceId !== null && row.status !== null) subs.push({ status: row.status, stripePriceId: row.stripePriceId });
    byUser.set(row.userId, subs);
  }
  return [...byUser.entries()].map(([userId, subs]) => ({ userId, subscriptions: subs }));
}

/**
 * The tier to write for a 'founder' user, or null to leave them for a human.
 * The same rule the webhook and reconciler use (deriveTierFromSubscriptions):
 * only an active/trialing row counts. A write happens only for a determinate,
 * PAID tier — a canceled or past_due Founder subscriber already reads as Free
 * and must not be promoted, and an unmapped price is not a tier.
 */
export function founderTierToWrite(
  subscriptions: readonly SubscriptionRowLike[],
  priceTier: PriceTierResolver,
): Exclude<SubscriptionTierName, 'free'> | null {
  const derived = deriveTierFromSubscriptions(subscriptions, priceTier);
  return derived.tier === 'free' || derived.indeterminate ? null : derived.tier;
}

/** Users with an entitled subscription on the legacy $100 personal Business price, once each. */
export function selectLegacyBusinessSubscribers(
  rows: readonly SubscribedUserCandidate[],
  legacyBusinessPriceId: string,
): LegacyBusinessRow[] {
  const byUser = new Map<string, LegacyBusinessRow>();
  for (const row of sorted(rows)) {
    const keepsGrandfathering = row.status !== null && GRANDFATHER_STATUSES.includes(row.status);
    if (row.stripePriceId !== legacyBusinessPriceId || !keepsGrandfathering || byUser.has(row.userId)) continue;
    byUser.set(row.userId, { userId: row.userId, subscriptionGrandfathered: row.subscriptionGrandfathered });
  }
  return [...byUser.values()];
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
    const tier = founderTierToWrite(row.subscriptions, deriveTier);
    const statuses = row.subscriptions.map((sub) => `${sub.stripePriceId}:${sub.status}`).join(', ') || 'no subscriptions';
    if (tier === null) {
      summary.founderTierUnresolved++;
      log(`${mode}  ${row.userId}: no active/trialing subscription on a mapped paid price (${statuses}) — left for review`);
      continue;
    }
    summary.normalized++;
    log(`${mode}  ${row.userId}: users.subscriptionTier founder → ${tier} (${statuses})`);
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
  // SQL only narrows to candidate rows; every selection and status rule is the
  // pure select* functions above, so the tests exercise the same rules.
  const candidates = (): Promise<SubscribedUserCandidate[]> =>
    db
      .select({
        userId: users.id,
        subscriptionTier: users.subscriptionTier,
        subscriptionGrandfathered: users.subscriptionGrandfathered,
        stripeSubscriptionId: subscriptions.stripeSubscriptionId,
        stripePriceId: subscriptions.stripePriceId,
        status: subscriptions.status,
        updatedAt: subscriptions.updatedAt,
      })
      .from(users)
      .leftJoin(subscriptions, eq(subscriptions.userId, users.id))
      .where(
        or(
          eq(users.subscriptionTier, 'founder'),
          eq(subscriptions.stripePriceId, priceIds.founder),
          eq(subscriptions.stripePriceId, priceIds.legacyBusiness),
        ),
      )
      .orderBy(asc(users.id), desc(subscriptions.updatedAt), asc(subscriptions.stripeSubscriptionId));
  return {
    async listFounderPriceSubscriptions() {
      return selectFounderPriceSubscriptions(await candidates(), priceIds.founder);
    },
    async listFounderTierUsers() {
      return selectFounderTierUsers(await candidates());
    },
    async normalizeFounderTier(userId, tier) {
      await db
        .update(users)
        .set({ subscriptionTier: tier })
        .where(and(eq(users.id, userId), eq(users.subscriptionTier, 'founder')));
    },
    async listLegacyBusinessSubscribers() {
      return selectLegacyBusinessSubscribers(await candidates(), priceIds.legacyBusiness);
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
      store: createDrizzleStore(getMigrationDb(), migrationPriceIds(stripeConfig)),
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
