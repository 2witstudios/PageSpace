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
 * DESIGN (round 3, structural rewrite — independent review + point-guard):
 * this script migrates exactly ONE known account (Jono's), not a general
 * population. Earlier rounds hardened a general-purpose Stripe schedule
 * RECONCILER — a function that decided a schedule was "already correct"
 * (`db-only`) by NEGATIVE match: anything not specifically flagged wrong was
 * accepted. The independent reviewer kept finding new schedule shapes that
 * slipped through as "already correct" when they were not (a mid-period
 * switch to the legacy Business price, a Pro phase with the wrong quantity,
 * an extra item, `end_behavior: 'cancel'`, an extra phase, a changed
 * discount) — a negative match cannot be exhaustively hardened; every round
 * just found the next gap.
 *
 * This version is POSITIVE match only, everywhere:
 *   (A) a RECOGNISED start state (single Founder-price item, quantity 1,
 *       active, not cancelling, no existing schedule) creates the schedule.
 *   (B) a RECOGNISED done state (an existing schedule whose phases are
 *       BYTE-FOR-BYTE what the same pure builder in (A) would produce —
 *       same phase count, prices, quantities, item counts, discounts,
 *       boundary, and `end_behavior: 'release'`) completes the local write
 *       only, never touches Stripe again.
 *   (C) anything else — including every shape above — REFUSES: zero Stripe
 *       writes, zero DB writes, the full schedule and subscription are
 *       logged so a human decides. There is no "fix the schedule" path; the
 *       script never mutates a schedule it did not itself just create in
 *       exactly the expected form.
 *
 * Safely re-runnable to a correct end state: case (B) is the retry path for
 * a run that created the schedule but crashed before `recordFounderToPro` —
 * the schedule already matches exactly what this script would have created,
 * so only the local write is missing. A user already flagged grandfathered
 * is skipped.
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
  /**
   * The user's CURRENTLY STORED tier. Read alongside the row so the runner
   * can tell "Stripe already reflects the move" apart from "the local write
   * also landed" — a row must not be skipped just because Stripe looks
   * right; the local write can still be missing (a crashed prior run).
   */
  subscriptionTier: string;
  /** The subscription row's CURRENTLY STORED schedule id, if any (same purpose). */
  stripeScheduleId: string | null;
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

/**
 * A coupon/promotion-code discount, id-only — whatever Stripe's SDK expanded
 * this to on read, this app never needs the expanded object, only the id to
 * write back on the next schedule update.
 */
export interface SchedulePhaseDiscount {
  coupon?: string;
  discount?: string;
  promotion_code?: string;
}

export interface SchedulePhaseItem {
  price: string;
  /**
   * Always populated explicitly by the adapter (Stripe's own default is 1
   * when omitted) so every comparison in this file compares an actual
   * number, never "undefined means probably 1".
   */
  quantity: number;
}

export interface SchedulePhase {
  items: SchedulePhaseItem[];
  start_date: number;
  end_date?: number;
  /**
   * Always populated explicitly by the adapter as an array (possibly
   * empty), never omitted — so phase equality never has to treat "no
   * discounts key" and "empty discounts array" as the same thing.
   */
  discounts: SchedulePhaseDiscount[];
}

/** The subset of a Stripe subscription the plan needs. */
export interface StripeSubscriptionView {
  id: string;
  /** Existing schedule id, if the subscription already carries one. */
  scheduleId: string | null;
  /** Stripe's subscription status (`active`, `past_due`, `canceled`, ...). */
  status: string;
  /** Every line item on the subscription — the RECOGNISED start state requires exactly one. */
  items: SchedulePhaseItem[];
  /** Unix seconds; item-level period end (API 2025-08-27+). */
  currentPeriodEnd: number;
  /** Whether the subscription is set to cancel at period end. */
  cancelAtPeriodEnd: boolean;
  /** Unix seconds the subscription is set to cancel at, or null. */
  cancelAt: number | null;
  /** The subscription's current discounts — carried unchanged into the created Founder phase. */
  discounts: SchedulePhaseDiscount[];
}

export interface StripeScheduleView {
  id: string;
  /** Unix seconds start of the schedule's first phase. */
  firstPhaseStart: number;
}

/** An EXISTING schedule's full shape, as read from Stripe. */
export interface ExistingSchedule {
  phases: SchedulePhase[];
  /** Stripe's `end_behavior` — must be `'release'` to be the recognised done state. */
  endBehavior: string;
}

/** What the script asks of Stripe. */
export interface MigrationStripe {
  retrieveSubscription(id: string): Promise<StripeSubscriptionView>;
  createScheduleFromSubscription(subscriptionId: string): Promise<StripeScheduleView>;
  updateSchedulePhases(scheduleId: string, phases: SchedulePhase[], endBehavior: string): Promise<void>;
  /** The EXISTING schedule a subscription already carries — phases and end_behavior. */
  retrieveSchedule(scheduleId: string): Promise<ExistingSchedule>;
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
 * The exact two phases the migration ever produces or recognises as correct:
 * the current Founder item (quantity 1, its existing discounts carried
 * through unchanged) until `currentPeriodEnd`, then Pro (quantity 1, no
 * discounts) from `currentPeriodEnd` on. Both the CREATE path (A) and the
 * DONE-state check (B) call this one builder, so they cannot drift apart —
 * "what we would create" and "what we accept as already-correct" are always
 * the same shape. Pure.
 */
export function expectedProSchedulePhases(
  live: StripeSubscriptionView,
  firstPhaseStart: number,
  priceIds: MigrationPriceIds,
): SchedulePhase[] {
  return [
    {
      items: [{ price: priceIds.founder, quantity: 1 }],
      start_date: firstPhaseStart,
      end_date: live.currentPeriodEnd,
      discounts: live.discounts,
    },
    {
      items: [{ price: priceIds.pro, quantity: 1 }],
      start_date: live.currentPeriodEnd,
      discounts: [],
    },
  ];
}

function phasesEqual(a: SchedulePhase[], b: SchedulePhase[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether `live` is the RECOGNISED Founder subscription shape this migration
 * knows how to handle: exactly one item, on the Founder price, quantity 1,
 * active, not cancelling. Anything else — a second item, a different
 * quantity, a different price, a non-active status, a cancellation — is not
 * positively recognised, so the caller refuses rather than guesses. Pure.
 */
function isRecognisedFounderSubscription(live: StripeSubscriptionView, priceIds: MigrationPriceIds): boolean {
  return (
    live.items.length === 1 &&
    live.items[0].price === priceIds.founder &&
    live.items[0].quantity === 1 &&
    live.status === 'active' &&
    !live.cancelAtPeriodEnd &&
    live.cancelAt === null
  );
}

export type FounderAction =
  /** (A) Recognised start state, no existing schedule — create one. */
  | { kind: 'create-schedule'; userId: string; stripeSubscriptionId: string }
  /** Recognised subscription shape, already carries a schedule — fetch and classify it (B or C). */
  | { kind: 'check-existing-schedule'; userId: string; stripeSubscriptionId: string; scheduleId: string }
  /** Live price is not the Founder price at all — a stale DB row, benign, no action. */
  | { kind: 'not-on-founder-price'; userId: string; stripeSubscriptionId: string; currentPriceId: string }
  /**
   * (C) Fail closed (Vision principle 6): the subscription itself is not the
   * one recognised shape (wrong quantity, a second item, not active,
   * cancelling). No Stripe or local write, ever. `reason` is logged and
   * counted so a human reviews it.
   */
  | { kind: 'refuse'; userId: string; stripeSubscriptionId: string; reason: string };

/** Decide what to do with one Founder row given its live Stripe state. Pure. */
export function planFounderAction(
  row: FounderSubscriptionRow,
  live: StripeSubscriptionView,
  priceIds: MigrationPriceIds,
): FounderAction {
  if (live.items.length === 1 && live.items[0].price !== priceIds.founder) {
    return {
      kind: 'not-on-founder-price',
      userId: row.userId,
      stripeSubscriptionId: row.stripeSubscriptionId,
      currentPriceId: live.items[0].price,
    };
  }
  if (!isRecognisedFounderSubscription(live, priceIds)) {
    return {
      kind: 'refuse',
      userId: row.userId,
      stripeSubscriptionId: row.stripeSubscriptionId,
      reason:
        `subscription is not the recognised single-item, quantity-1, active, non-cancelling ` +
        `Founder shape this migration handles — refusing rather than guessing. ` +
        `live: ${JSON.stringify({ status: live.status, items: live.items, cancelAtPeriodEnd: live.cancelAtPeriodEnd, cancelAt: live.cancelAt })}`,
    };
  }
  if (live.scheduleId == null) {
    return { kind: 'create-schedule', userId: row.userId, stripeSubscriptionId: row.stripeSubscriptionId };
  }
  return { kind: 'check-existing-schedule', userId: row.userId, stripeSubscriptionId: row.stripeSubscriptionId, scheduleId: live.scheduleId };
}

export type ExistingScheduleVerdict =
  /** (B) Stripe already exactly matches AND the local write already landed — true no-op. */
  | { kind: 'complete' }
  /** (B) Stripe already exactly matches; the local write never landed (retry-after-partial-failure). */
  | { kind: 'record-local' }
  /**
   * (C) The existing schedule is not byte-for-byte the expected shape — a
   * different phase count, a different price or quantity on any item, a
   * different boundary, a different `end_behavior`, or a changed discount.
   * No fix is attempted; the full schedule is included in `reason` for a
   * human to read.
   */
  | { kind: 'refuse'; reason: string };

/**
 * What to do about a Founder subscription that ALREADY carries a schedule:
 * classify it against the one pure builder (`expectedProSchedulePhases`)
 * rather than inspecting it for known-bad shapes. Pure given the schedule's
 * already-fetched phases and end_behavior.
 */
export function planExistingScheduleAction(
  row: FounderSubscriptionRow,
  live: StripeSubscriptionView,
  scheduleId: string,
  schedule: ExistingSchedule,
  priceIds: MigrationPriceIds,
): ExistingScheduleVerdict {
  const firstPhaseStart = schedule.phases[0]?.start_date;
  const expected = firstPhaseStart === undefined ? null : expectedProSchedulePhases(live, firstPhaseStart, priceIds);
  const matches = schedule.endBehavior === 'release' && expected !== null && phasesEqual(schedule.phases, expected);
  if (!matches) {
    return {
      kind: 'refuse',
      reason:
        `schedule ${scheduleId} is not byte-for-byte the expected Founder-until-period-end, ` +
        `then-Pro schedule — refusing to touch it rather than guess a fix. ` +
        `end_behavior=${schedule.endBehavior}, phases=${JSON.stringify(schedule.phases)}, ` +
        `expected=${JSON.stringify(expected)}`,
    };
  }
  const localComplete = row.subscriptionTier === 'pro' && row.stripeScheduleId === scheduleId;
  return localComplete ? { kind: 'complete' } : { kind: 'record-local' };
}

export interface MigrationSummary {
  dryRun: boolean;
  founderRows: number;
  /** (A) A new schedule was created (or would be, in dry-run). */
  created: number;
  /** (B) Existing schedule exactly matches AND the local write already landed. */
  alreadyComplete: number;
  /** (B) Existing schedule exactly matches; the local write was missing and is now completed. */
  recorded: number;
  /**
   * (C) Fail closed (Vision principle 6): a row this planner refused to
   * touch — the subscription itself is not the recognised shape, or an
   * existing schedule does not byte-for-byte match — rather than guess or
   * fix. Zero writes; needs a human.
   */
  refused: number;
  /** Live Stripe price is not the Founder price — stale DB row, benign, no action. */
  notOnFounderPrice: number;
  /** An unexpected per-row error (a Stripe/DB call itself threw) that stopped only this row. */
  failed: number;
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
    created: 0,
    alreadyComplete: 0,
    recorded: 0,
    refused: 0,
    notOnFounderPrice: 0,
    failed: 0,
    legacyBusinessRows: 0,
    grandfathered: 0,
    alreadyGrandfathered: 0,
  };
  const mode = opts.dryRun ? '[dry-run] ' : '';

  // 1. Founder → Pro at period end.
  const founderRows = await store.listFounderSubscriptions();
  summary.founderRows = founderRows.length;
  log(`${mode}${founderRows.length} subscription(s) on the Founder price`);

  // Each row is isolated in its own try/catch: an unexpected per-row error
  // (a Stripe/DB call itself throwing) stops only that row, not the whole
  // migration — the remaining Founder rows and step 2 (grandfathering) still
  // run.
  for (const row of founderRows) {
    try {
      const live = await stripe.retrieveSubscription(row.stripeSubscriptionId);
      const action = planFounderAction(row, live, priceIds);
      switch (action.kind) {
        case 'not-on-founder-price':
          summary.notOnFounderPrice++;
          log(`${mode}  ${row.userId}: ${row.stripeSubscriptionId} is on ${action.currentPriceId}, not the Founder price — skipped`);
          break;
        case 'refuse':
          summary.refused++;
          log(`${mode}  ${row.userId}: ${row.stripeSubscriptionId} REFUSED — ${action.reason} — no writes, needs a human`);
          break;
        case 'create-schedule': {
          const changeDate = new Date(live.currentPeriodEnd * 1000);
          log(`${mode}  ${row.userId}: create schedule ${row.stripeSubscriptionId} → Pro (${priceIds.pro}) at ${changeDate.toISOString()}; users.subscriptionTier → pro now`);
          summary.created++;
          if (opts.dryRun) break;
          const schedule = await stripe.createScheduleFromSubscription(live.id);
          const phases = expectedProSchedulePhases(live, schedule.firstPhaseStart, priceIds);
          await stripe.updateSchedulePhases(schedule.id, phases, 'release');
          await store.recordFounderToPro({
            userId: row.userId,
            stripeSubscriptionId: row.stripeSubscriptionId,
            stripeScheduleId: schedule.id,
            scheduledPriceId: priceIds.pro,
            scheduledChangeDate: changeDate,
          });
          break;
        }
        case 'check-existing-schedule': {
          const scheduleId = action.scheduleId;
          const schedule = await stripe.retrieveSchedule(scheduleId);
          const verdict = planExistingScheduleAction(row, live, scheduleId, schedule, priceIds);
          switch (verdict.kind) {
            case 'complete':
              summary.alreadyComplete++;
              log(`${mode}  ${row.userId}: ${scheduleId} already exactly matches and the local write already landed — nothing to do`);
              break;
            case 'record-local':
              summary.recorded++;
              log(`${mode}  ${row.userId}: ${scheduleId} already exactly matches; completing the local write (a prior run's retry target)`);
              if (!opts.dryRun) {
                await store.recordFounderToPro({
                  userId: row.userId,
                  stripeSubscriptionId: row.stripeSubscriptionId,
                  stripeScheduleId: scheduleId,
                  scheduledPriceId: priceIds.pro,
                  scheduledChangeDate: new Date(live.currentPeriodEnd * 1000),
                });
              }
              break;
            case 'refuse':
              summary.refused++;
              log(`${mode}  ${row.userId}: ${scheduleId} REFUSED — ${verdict.reason} — no writes, needs a human`);
              break;
          }
          break;
        }
      }
    } catch (err) {
      summary.failed++;
      const message = err instanceof Error ? err.message : String(err);
      log(`${mode}  ${row.userId}: ${row.stripeSubscriptionId} FAILED — ${message} — skipped, continuing with the rest of the migration`);
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
    `${mode}Summary: founder rows ${summary.founderRows} (created ${summary.created}, already complete ${summary.alreadyComplete}, ` +
      `recorded on retry ${summary.recorded}, refused ${summary.refused}, not on founder price ${summary.notOnFounderPrice}, ` +
      `failed ${summary.failed}); legacy business rows ${summary.legacyBusinessRows} ` +
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
          subscriptionTier: users.subscriptionTier,
          stripeScheduleId: subscriptions.stripeScheduleId,
        })
        .from(subscriptions)
        .innerJoin(users, eq(users.id, subscriptions.userId))
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

function idOf(v: string | { id: string } | null | undefined): string | undefined {
  return v == null ? undefined : typeof v === 'string' ? v : v.id;
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
        status: sub.status,
        items: sub.items.data.map((it) => ({ price: it.price.id, quantity: it.quantity ?? 1 })),
        currentPeriodEnd: item.current_period_end,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        cancelAt: sub.cancel_at ?? null,
        // A Subscription's `discounts` are full Discount objects (or ids),
        // not the {coupon,discount,promotion_code} param shape a schedule
        // phase write expects — the Discount's own id round-trips as the
        // `discount` field, which Stripe's schedule-update API accepts.
        discounts: sub.discounts.map((d) => ({ discount: idOf(d) })),
      };
    },
    async createScheduleFromSubscription(subscriptionId) {
      const schedule = await stripe.subscriptionSchedules.create({ from_subscription: subscriptionId });
      return { id: schedule.id, firstPhaseStart: schedule.phases[0].start_date };
    },
    async updateSchedulePhases(scheduleId, phases, endBehavior) {
      await stripe.subscriptionSchedules.update(scheduleId, {
        phases,
        end_behavior: endBehavior as import('stripe').Stripe.SubscriptionScheduleUpdateParams.EndBehavior,
      });
    },
    async retrieveSchedule(scheduleId) {
      const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
      return {
        endBehavior: schedule.end_behavior,
        phases: schedule.phases.map((phase) => ({
          items: phase.items.map((item) => ({
            price: typeof item.price === 'string' ? item.price : item.price.id,
            quantity: item.quantity ?? 1,
          })),
          start_date: phase.start_date,
          end_date: phase.end_date ?? undefined,
          discounts: phase.discounts.map((d) => ({
            coupon: idOf(d.coupon),
            discount: idOf(d.discount),
            promotion_code: idOf(d.promotion_code),
          })),
        })),
      };
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
  if (summary.failed > 0) {
    console.warn(`${summary.failed} row(s) failed and were skipped — review the FAILED lines above and re-run once fixed.`);
  }
  if (summary.refused > 0) {
    console.warn(`${summary.refused} row(s) were REFUSED (not the one recognised shape) — review the REFUSED lines above; a human must decide.`);
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
