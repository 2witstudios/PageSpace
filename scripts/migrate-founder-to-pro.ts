#!/usr/bin/env bun
/**
 * One-shot migration for A-9 (Organizations & Wallets, SEAT-2): the Founder
 * tier is removed from the vocabulary.
 *
 *   1. Every subscription still on the retired Founder price is moved to Pro
 *      AT PERIOD END — a Stripe subscription schedule (current phase on the
 *      Founder price until `current_period_end`, next phase on the Pro price),
 *      never an immediate price swap, so nothing is prorated mid-period.
 *      `users.subscriptionTier` is written to 'pro' NOW, not when the phase
 *      lands: 'founder' is outside the vocabulary from this deploy on, and an
 *      out-of-vocabulary value coerces to 'free' at every read site
 *      (toSubscriptionTier) — leaving it in place would strip the subscriber
 *      to Free entitlements for the rest of the period. The Stripe webhook
 *      (customer.subscription.updated) writes 'pro' again when the schedule's
 *      second phase starts, through the same price→tier map, so the column
 *      and Stripe agree at both moments.
 *   2. Every subscriber on the legacy $100 personal Business price is marked
 *      `users.subscriptionGrandfathered = true`: Business entitlements at the
 *      price they already pay (A-9). A flag, not a tier — their tier stays
 *      'business'. No new signups at that price.
 *
 * Idempotent: a subscription that already carries a schedule is left alone
 * (reported as `already-scheduled`), and a user already flagged is skipped.
 *
 * Usage:
 *   bun scripts/migrate-founder-to-pro.ts --dry-run    # plan only, no writes
 *   bun scripts/migrate-founder-to-pro.ts              # execute
 *
 * Runs on the migration day chosen at Standup 4 (Sequence Spec), not before.
 * Env: DATABASE_URL, STRIPE_SECRET_KEY (live or test to match stripe-config).
 */
import { pathToFileURL } from 'node:url';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { ENTITLED_SUBSCRIPTION_STATUSES } from '@pagespace/lib/billing/subscription-tier-sync';

// ─── Seams ───────────────────────────────────────────────────────────────────

/** A subscription row that must move from Founder to Pro. */
export interface FounderSubscriptionRow {
  userId: string;
  stripeSubscriptionId: string;
  status: string;
}

/** A user on the legacy $100 personal Business price. */
export interface LegacyBusinessRow {
  userId: string;
  subscriptionGrandfathered: boolean;
}

/** What the script reads and writes in Postgres. */
export interface MigrationStore {
  listFounderSubscriptions(): Promise<FounderSubscriptionRow[]>;
  listLegacyBusinessSubscribers(): Promise<LegacyBusinessRow[]>;
  /** Write the Pro tier now and record the pending schedule on the subscription row. */
  recordFounderToPro(input: {
    userId: string;
    stripeSubscriptionId: string;
    stripeScheduleId: string;
    scheduledPriceId: string;
    scheduledChangeDate: Date;
  }): Promise<void>;
  markGrandfathered(userId: string): Promise<void>;
}

/** The subset of a Stripe subscription the plan needs. */
export interface StripeSubscriptionView {
  id: string;
  /** Existing schedule id, if the subscription already carries one. */
  scheduleId: string | null;
  /** Price id of the first item — the one the plan must keep until period end. */
  currentPriceId: string;
  /** Unix seconds; item-level period end (API 2025-08-27+). */
  currentPeriodEnd: number;
}

export interface StripeScheduleView {
  id: string;
  /** Unix seconds start of the schedule's first phase. */
  firstPhaseStart: number;
}

export interface SchedulePhase {
  items: { price: string }[];
  start_date: number;
  end_date?: number;
}

/** What the script asks of Stripe. */
export interface MigrationStripe {
  retrieveSubscription(id: string): Promise<StripeSubscriptionView>;
  createScheduleFromSubscription(subscriptionId: string): Promise<StripeScheduleView>;
  updateSchedulePhases(scheduleId: string, phases: SchedulePhase[]): Promise<void>;
}

export interface MigrationPriceIds {
  founder: string;
  pro: string;
}

export interface MigrationDeps {
  store: MigrationStore;
  stripe: MigrationStripe;
  priceIds: MigrationPriceIds;
  log: (line: string) => void;
}

// ─── Pure planning ───────────────────────────────────────────────────────────

/**
 * The two phases that move a Founder subscription to Pro at period end:
 * keep the current price until `currentPeriodEnd`, then Pro. Pure.
 */
export function founderToProPhases(
  sub: StripeSubscriptionView,
  schedule: StripeScheduleView,
  proPriceId: string,
): SchedulePhase[] {
  return [
    { items: [{ price: sub.currentPriceId }], start_date: schedule.firstPhaseStart, end_date: sub.currentPeriodEnd },
    { items: [{ price: proPriceId }], start_date: sub.currentPeriodEnd },
  ];
}

export type FounderAction =
  | { kind: 'schedule'; userId: string; stripeSubscriptionId: string }
  | { kind: 'already-scheduled'; userId: string; stripeSubscriptionId: string; scheduleId: string }
  | { kind: 'not-on-founder-price'; userId: string; stripeSubscriptionId: string; currentPriceId: string };

/** Decide what to do with one Founder row given its live Stripe state. Pure. */
export function planFounderAction(
  row: FounderSubscriptionRow,
  live: StripeSubscriptionView,
  priceIds: MigrationPriceIds,
): FounderAction {
  if (live.currentPriceId !== priceIds.founder) {
    return { kind: 'not-on-founder-price', userId: row.userId, stripeSubscriptionId: row.stripeSubscriptionId, currentPriceId: live.currentPriceId };
  }
  if (live.scheduleId) {
    return { kind: 'already-scheduled', userId: row.userId, stripeSubscriptionId: row.stripeSubscriptionId, scheduleId: live.scheduleId };
  }
  return { kind: 'schedule', userId: row.userId, stripeSubscriptionId: row.stripeSubscriptionId };
}

export interface MigrationSummary {
  dryRun: boolean;
  founderRows: number;
  scheduled: number;
  alreadyScheduled: number;
  skippedNotOnFounderPrice: number;
  legacyBusinessRows: number;
  grandfathered: number;
  alreadyGrandfathered: number;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export async function runFounderMigration(deps: MigrationDeps, opts: { dryRun: boolean }): Promise<MigrationSummary> {
  const { store, stripe, priceIds, log } = deps;
  const summary: MigrationSummary = {
    dryRun: opts.dryRun,
    founderRows: 0,
    scheduled: 0,
    alreadyScheduled: 0,
    skippedNotOnFounderPrice: 0,
    legacyBusinessRows: 0,
    grandfathered: 0,
    alreadyGrandfathered: 0,
  };
  const mode = opts.dryRun ? '[dry-run] ' : '';

  // 1. Founder → Pro at period end.
  const founderRows = await store.listFounderSubscriptions();
  summary.founderRows = founderRows.length;
  log(`${mode}${founderRows.length} subscription(s) on the Founder price`);

  for (const row of founderRows) {
    const live = await stripe.retrieveSubscription(row.stripeSubscriptionId);
    const action = planFounderAction(row, live, priceIds);
    switch (action.kind) {
      case 'not-on-founder-price':
        summary.skippedNotOnFounderPrice++;
        log(`${mode}  ${row.userId}: ${row.stripeSubscriptionId} is on ${action.currentPriceId}, not the Founder price — skipped`);
        break;
      case 'already-scheduled':
        summary.alreadyScheduled++;
        log(`${mode}  ${row.userId}: ${row.stripeSubscriptionId} already carries schedule ${action.scheduleId} — skipped`);
        break;
      case 'schedule': {
        const changeDate = new Date(live.currentPeriodEnd * 1000);
        log(`${mode}  ${row.userId}: schedule ${row.stripeSubscriptionId} → Pro (${priceIds.pro}) at ${changeDate.toISOString()}; users.subscriptionTier → pro now`);
        summary.scheduled++;
        if (opts.dryRun) break;
        const schedule = await stripe.createScheduleFromSubscription(live.id);
        await stripe.updateSchedulePhases(schedule.id, founderToProPhases(live, schedule, priceIds.pro));
        await store.recordFounderToPro({
          userId: row.userId,
          stripeSubscriptionId: row.stripeSubscriptionId,
          stripeScheduleId: schedule.id,
          scheduledPriceId: priceIds.pro,
          scheduledChangeDate: changeDate,
        });
        break;
      }
    }
  }

  // 2. Grandfather the legacy $100 personal Business subscribers.
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
    if (!opts.dryRun) await store.markGrandfathered(row.userId);
  }

  log(
    `${mode}Summary: founder rows ${summary.founderRows} (scheduled ${summary.scheduled}, already scheduled ${summary.alreadyScheduled}, ` +
      `not on founder price ${summary.skippedNotOnFounderPrice}); legacy business rows ${summary.legacyBusinessRows} ` +
      `(grandfathered ${summary.grandfathered}, already ${summary.alreadyGrandfathered})`,
  );
  return summary;
}

// ─── Real adapters (IO at the edges) ─────────────────────────────────────────

/** The drizzle surface the store uses; typed narrowly so the runner never sees the ORM. */
type MigrationDb = typeof import('@pagespace/db/db').db;

export function createDrizzleStore(db: MigrationDb, priceIds: { founder: string; legacyBusiness: string }): MigrationStore {
  const entitled = [...ENTITLED_SUBSCRIPTION_STATUSES, 'past_due'];
  return {
    async listFounderSubscriptions() {
      const rows = await db
        .select({
          userId: subscriptions.userId,
          stripeSubscriptionId: subscriptions.stripeSubscriptionId,
          status: subscriptions.status,
        })
        .from(subscriptions)
        .where(and(eq(subscriptions.stripePriceId, priceIds.founder), inArray(subscriptions.status, entitled)));
      return rows;
    },
    async listLegacyBusinessSubscribers() {
      const rows = await db
        .select({ userId: users.id, subscriptionGrandfathered: users.subscriptionGrandfathered })
        .from(subscriptions)
        .innerJoin(users, eq(users.id, subscriptions.userId))
        .where(and(eq(subscriptions.stripePriceId, priceIds.legacyBusiness), inArray(subscriptions.status, entitled)));
      return rows;
    },
    async recordFounderToPro(input) {
      await db.transaction(async (tx) => {
        await tx.update(users).set({ subscriptionTier: 'pro' }).where(eq(users.id, input.userId));
        await tx
          .update(subscriptions)
          .set({
            stripeScheduleId: input.stripeScheduleId,
            scheduledPriceId: input.scheduledPriceId,
            scheduledChangeDate: input.scheduledChangeDate,
          })
          .where(eq(subscriptions.stripeSubscriptionId, input.stripeSubscriptionId));
      });
    },
    async markGrandfathered(userId) {
      await db.update(users).set({ subscriptionGrandfathered: true }).where(eq(users.id, userId));
    },
  };
}

export function createStripeAdapter(stripe: import('stripe').Stripe): MigrationStripe {
  return {
    async retrieveSubscription(id) {
      const sub = await stripe.subscriptions.retrieve(id);
      const firstItem = sub.items.data[0];
      if (!firstItem) throw new Error(`Subscription ${id} has no items`);
      // Item-level period end (Stripe API 2025-08-27+), as the webhook reads it.
      const item = firstItem as typeof firstItem & { current_period_end?: number };
      if (typeof item.current_period_end !== 'number') throw new Error(`Subscription ${id}: item has no current_period_end`);
      return {
        id: sub.id,
        scheduleId: sub.schedule == null ? null : typeof sub.schedule === 'string' ? sub.schedule : sub.schedule.id,
        currentPriceId: firstItem.price.id,
        currentPeriodEnd: item.current_period_end,
      };
    },
    async createScheduleFromSubscription(subscriptionId) {
      const schedule = await stripe.subscriptionSchedules.create({ from_subscription: subscriptionId });
      return { id: schedule.id, firstPhaseStart: schedule.phases[0].start_date };
    },
    async updateSchedulePhases(scheduleId, phases) {
      await stripe.subscriptionSchedules.update(scheduleId, { phases });
    },
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  // Price ids come from the web app's hardcoded Stripe config (test vs live
  // follows NODE_ENV / NEXT_PUBLIC_STRIPE_MODE exactly as the app does).
  const { stripeConfig, stripeMode } = await import('../apps/web/src/lib/stripe-config');
  const { stripe } = await import('../apps/web/src/lib/stripe/client');
  const { getMigrationDb } = await import('@pagespace/db/db');
  if (!dryRun && !process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is required (or pass --dry-run)');
  }
  console.log(`Stripe mode: ${stripeMode}${dryRun ? ' (dry run — no writes)' : ''}`);
  const store = createDrizzleStore(getMigrationDb(), {
    founder: stripeConfig.grandfatheredPriceIds.founder,
    legacyBusiness: stripeConfig.priceIds.business,
  });
  const summary = await runFounderMigration(
    {
      store,
      stripe: createStripeAdapter(stripe),
      priceIds: { founder: stripeConfig.grandfatheredPriceIds.founder, pro: stripeConfig.priceIds.pro },
      log: (line) => console.log(line),
    },
    { dryRun },
  );
  if (summary.founderRows > 1) {
    console.warn(`Expected a single Founder subscriber (A-9) but found ${summary.founderRows}; review the rows above.`);
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
