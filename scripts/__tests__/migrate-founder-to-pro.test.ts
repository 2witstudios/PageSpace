/**
 * A-9 — scripts/migrate-founder-to-pro.ts against a seeded Founder row.
 *
 * The store and Stripe seams are in-memory fakes that RECORD every write, so
 * "no writes in dry-run" is a real assertion, not a vacuous one.
 */
import { describe, it, expect } from 'vitest';
import {
  runFounderMigration,
  planFounderAction,
  founderToProPhases,
  scheduleTargetsPro,
  reconcilePhasesToPro,
  planScheduleReconciliation,
  type FounderSubscriptionRow,
  type LegacyBusinessRow,
  type MigrationStore,
  type MigrationStripe,
  type StripeSubscriptionView,
  type SchedulePhase,
} from '../migrate-founder-to-pro';

const PRICE = { founder: 'price_founder_50', pro: 'price_pro_15', legacyBusiness: 'price_business_100' };
const PERIOD_END = 1_790_000_000; // unix seconds
const PHASE_START = 1_787_000_000;

interface Seed {
  founderRows?: FounderSubscriptionRow[];
  legacyRows?: LegacyBusinessRow[];
  stripeSubs?: Record<string, StripeSubscriptionView>;
}

interface StripeScheduleFake {
  phases: SchedulePhase[];
}

function seededDeps(seed: Seed, schedules: Record<string, StripeScheduleFake> = {}) {
  const writes = {
    recordFounderToPro: [] as Parameters<MigrationStore['recordFounderToPro']>[0][],
    markGrandfathered: [] as string[],
    schedulesCreated: [] as string[],
    scheduleUpdates: [] as { scheduleId: string; phases: SchedulePhase[] }[],
    schedulePhaseReads: [] as string[],
  };
  const store: MigrationStore = {
    listFounderSubscriptions: async () => seed.founderRows ?? [],
    listLegacyBusinessSubscribers: async () => seed.legacyRows ?? [],
    recordFounderToPro: async (input) => {
      writes.recordFounderToPro.push(input);
    },
    markGrandfathered: async (userId) => {
      writes.markGrandfathered.push(userId);
    },
  };
  const stripe: MigrationStripe = {
    retrieveSubscription: async (id) => {
      const sub = seed.stripeSubs?.[id];
      if (!sub) throw new Error(`no stripe sub ${id}`);
      return sub;
    },
    createScheduleFromSubscription: async (subscriptionId) => {
      writes.schedulesCreated.push(subscriptionId);
      return { id: `sched_for_${subscriptionId}`, firstPhaseStart: PHASE_START };
    },
    updateSchedulePhases: async (scheduleId, phases) => {
      writes.scheduleUpdates.push({ scheduleId, phases });
    },
    retrieveSchedulePhases: async (scheduleId) => {
      writes.schedulePhaseReads.push(scheduleId);
      const schedule = schedules[scheduleId];
      if (!schedule) throw new Error(`no fake schedule ${scheduleId}`);
      return schedule.phases;
    },
  };
  const lines: string[] = [];
  return {
    deps: { store, stripe, priceIds: { founder: PRICE.founder, pro: PRICE.pro }, log: (l: string) => lines.push(l) },
    writes,
    lines,
  };
}

/** The Northwind-era fixture: Jono on Founder, one legacy $100 Business user, one Pro user. */
function founderSeed(overrides: Partial<StripeSubscriptionView> = {}, rowOverrides: Partial<FounderSubscriptionRow> = {}): Seed {
  return {
    founderRows: [{
      userId: 'user_jono', stripeSubscriptionId: 'sub_jono', status: 'active',
      subscriptionTier: 'founder', stripeScheduleId: null, ...rowOverrides,
    }],
    legacyRows: [
      { userId: 'user_biz100', subscriptionGrandfathered: false },
      { userId: 'user_biz_done', subscriptionGrandfathered: true },
    ],
    stripeSubs: {
      sub_jono: { id: 'sub_jono', scheduleId: null, currentPriceId: PRICE.founder, currentPeriodEnd: PERIOD_END, ...overrides },
    },
  };
}

describe('planFounderAction (pure)', () => {
  const row: FounderSubscriptionRow = {
    userId: 'u', stripeSubscriptionId: 'sub', status: 'active',
    subscriptionTier: 'founder', stripeScheduleId: null,
  };

  it('A-9 schedules a live Founder subscription with no schedule', () => {
    expect(planFounderAction(row, { id: 'sub', scheduleId: null, currentPriceId: PRICE.founder, currentPeriodEnd: PERIOD_END }, PRICE))
      .toEqual({ kind: 'schedule', userId: 'u', stripeSubscriptionId: 'sub' });
  });

  it('A-9 is idempotent: a subscription already carrying a schedule is left alone', () => {
    expect(planFounderAction(row, { id: 'sub', scheduleId: 'sched_1', currentPriceId: PRICE.founder, currentPeriodEnd: PERIOD_END }, PRICE))
      .toEqual({ kind: 'already-scheduled', userId: 'u', stripeSubscriptionId: 'sub', scheduleId: 'sched_1' });
  });

  it('A-9 refuses to touch a subscription whose live price is not the Founder price (stale DB row)', () => {
    expect(planFounderAction(row, { id: 'sub', scheduleId: null, currentPriceId: PRICE.pro, currentPeriodEnd: PERIOD_END }, PRICE))
      .toEqual({ kind: 'not-on-founder-price', userId: 'u', stripeSubscriptionId: 'sub', currentPriceId: PRICE.pro });
  });
});

describe('founderToProPhases (pure)', () => {
  it('A-9 keeps the Founder price until period end, then Pro — a schedule, not an immediate swap', () => {
    const phases = founderToProPhases(
      { id: 'sub', scheduleId: null, currentPriceId: PRICE.founder, currentPeriodEnd: PERIOD_END },
      { id: 'sched', firstPhaseStart: PHASE_START },
      PRICE.pro,
    );
    expect(phases).toEqual([
      { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END },
      { items: [{ price: PRICE.pro }], start_date: PERIOD_END },
    ]);
  });
});

describe('scheduleTargetsPro (pure)', () => {
  it('A-9 P1 is true when the final phase is Pro', () => {
    expect(scheduleTargetsPro(
      [{ items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END }, { items: [{ price: PRICE.pro }], start_date: PERIOD_END }],
      PRICE.pro,
    )).toBe(true);
  });

  it('A-9 P1 is false when the final phase is not Pro (a schedule created but never updated)', () => {
    expect(scheduleTargetsPro([{ items: [{ price: PRICE.founder }], start_date: PHASE_START }], PRICE.pro)).toBe(false);
  });

  it('A-9 P1 is false for an empty phase list', () => {
    expect(scheduleTargetsPro([], PRICE.pro)).toBe(false);
  });
});

describe('reconcilePhasesToPro (pure)', () => {
  const sub: StripeSubscriptionView = { id: 'sub', scheduleId: 'sched', currentPriceId: PRICE.founder, currentPeriodEnd: PERIOD_END };

  it('A-9 P1 caps the single existing (indefinite) phase at period end and appends Pro', () => {
    const result = reconcilePhasesToPro(sub, [{ items: [{ price: PRICE.founder }], start_date: PHASE_START }], PRICE.pro);
    expect(result).toEqual([
      { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END },
      { items: [{ price: PRICE.pro }], start_date: PERIOD_END },
    ]);
  });

  it('A-9 P1 preserves earlier phases untouched and only rewrites the final one', () => {
    const result = reconcilePhasesToPro(
      sub,
      [
        { items: [{ price: 'price_trial' }], start_date: 1, end_date: PHASE_START },
        { items: [{ price: PRICE.founder }], start_date: PHASE_START },
      ],
      PRICE.pro,
    );
    expect(result).toEqual([
      { items: [{ price: 'price_trial' }], start_date: 1, end_date: PHASE_START },
      { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END },
      { items: [{ price: PRICE.pro }], start_date: PERIOD_END },
    ]);
  });

  it('A-9 P1 refuses a schedule with no phases at all', () => {
    expect(() => reconcilePhasesToPro(sub, [], PRICE.pro)).toThrow(/no phases/);
  });
});

describe('planScheduleReconciliation (pure)', () => {
  const row: FounderSubscriptionRow = {
    userId: 'u', stripeSubscriptionId: 'sub', status: 'active',
    subscriptionTier: 'founder', stripeScheduleId: null,
  };
  const live: StripeSubscriptionView = { id: 'sub', scheduleId: 'sched_1', currentPriceId: PRICE.founder, currentPeriodEnd: PERIOD_END };
  const proEndingPhases: SchedulePhase[] = [
    { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END },
    { items: [{ price: PRICE.pro }], start_date: PERIOD_END },
  ];
  const founderOnlyPhases: SchedulePhase[] = [{ items: [{ price: PRICE.founder }], start_date: PHASE_START }];

  it('A-9 P1 both Stripe and the local write already correct → complete (true no-op)', () => {
    const result = planScheduleReconciliation(
      { ...row, subscriptionTier: 'pro', stripeScheduleId: 'sched_1' },
      live, 'sched_1', proEndingPhases, PRICE.pro,
    );
    expect(result).toEqual({ kind: 'complete' });
  });

  it('A-9 P1 Stripe already ends on Pro but the local write is missing → db-only', () => {
    const result = planScheduleReconciliation(row, live, 'sched_1', proEndingPhases, PRICE.pro);
    expect(result).toEqual({ kind: 'db-only' });
  });

  it('A-9 P1 Stripe does not end on Pro (regardless of local state) → fix-schedule', () => {
    const result = planScheduleReconciliation(row, live, 'sched_1', founderOnlyPhases, PRICE.pro);
    expect(result).toEqual({
      kind: 'fix-schedule',
      phases: [
        { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END },
        { items: [{ price: PRICE.pro }], start_date: PERIOD_END },
      ],
    });
  });

  it('A-9 P1 a mismatched local schedule id (points at a stale/different schedule) is treated as incomplete', () => {
    const result = planScheduleReconciliation(
      { ...row, subscriptionTier: 'pro', stripeScheduleId: 'sched_stale' },
      live, 'sched_1', proEndingPhases, PRICE.pro,
    );
    expect(result).toEqual({ kind: 'db-only' });
  });
});

describe('runFounderMigration against a seeded Founder row', () => {
  it('A-9 --dry-run plans the move and the grandfathering but writes nothing to Stripe or the DB', async () => {
    const { deps, writes, lines } = seededDeps(founderSeed());
    const summary = await runFounderMigration(deps, { dryRun: true });

    expect(summary).toEqual({
      dryRun: true,
      founderRows: 1,
      scheduled: 1,
      alreadyComplete: 0,
      dbCompleted: 0,
      reconciled: 0,
      skippedNotOnFounderPrice: 0,
      legacyBusinessRows: 2,
      grandfathered: 1,
      alreadyGrandfathered: 1,
    });
    expect(writes.schedulesCreated).toEqual([]);
    expect(writes.scheduleUpdates).toEqual([]);
    expect(writes.recordFounderToPro).toEqual([]);
    expect(writes.markGrandfathered).toEqual([]);
    expect(lines.some((l) => l.includes('[dry-run]') && l.includes('user_jono'))).toBe(true);
  });

  it('A-9 executes: schedules Founder → Pro at period end, writes tier pro now with the schedule recorded, and grandfathers the $100 Business user once', async () => {
    const { deps, writes } = seededDeps(founderSeed());
    const summary = await runFounderMigration(deps, { dryRun: false });

    expect(summary.scheduled).toBe(1);
    expect(writes.schedulesCreated).toEqual(['sub_jono']);
    expect(writes.scheduleUpdates).toEqual([
      {
        scheduleId: 'sched_for_sub_jono',
        phases: [
          { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END },
          { items: [{ price: PRICE.pro }], start_date: PERIOD_END },
        ],
      },
    ]);
    expect(writes.recordFounderToPro).toEqual([
      {
        userId: 'user_jono',
        stripeSubscriptionId: 'sub_jono',
        stripeScheduleId: 'sched_for_sub_jono',
        scheduledPriceId: PRICE.pro,
        scheduledChangeDate: new Date(PERIOD_END * 1000),
      },
    ]);
    // Only the not-yet-flagged legacy Business user is written; the flagged one is skipped.
    expect(writes.markGrandfathered).toEqual(['user_biz100']);
    expect(summary.grandfathered).toBe(1);
    expect(summary.alreadyGrandfathered).toBe(1);
  });

  it('A-9 P1 a fully-completed row (Stripe ends on Pro, local write already landed) is a true no-op on retry', async () => {
    const seed = founderSeed(
      { scheduleId: 'sched_done' },
      { subscriptionTier: 'pro', stripeScheduleId: 'sched_done' },
    );
    const { deps, writes } = seededDeps(seed, {
      sched_done: {
        phases: [
          { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END },
          { items: [{ price: PRICE.pro }], start_date: PERIOD_END },
        ],
      },
    });
    const summary = await runFounderMigration(deps, { dryRun: false });

    expect(summary.alreadyComplete).toBe(1);
    expect(summary.dbCompleted).toBe(0);
    expect(summary.reconciled).toBe(0);
    expect(summary.scheduled).toBe(0);
    expect(writes.schedulesCreated).toEqual([]);
    expect(writes.scheduleUpdates).toEqual([]);
    expect(writes.recordFounderToPro).toEqual([]);
  });

  it('A-9 P1 retry after Stripe succeeded but the script crashed before recordFounderToPro: completes the local write without touching Stripe again', async () => {
    // The schedule already ends on Pro (a prior run's updateSchedulePhases succeeded),
    // but the row still says 'founder' with no local schedule id (recordFounderToPro
    // never ran) — this is the real founder account the P1 bug would leave stuck on Free.
    const seed = founderSeed(
      { scheduleId: 'sched_partial' },
      { subscriptionTier: 'founder', stripeScheduleId: null },
    );
    const { deps, writes } = seededDeps(seed, {
      sched_partial: {
        phases: [
          { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END },
          { items: [{ price: PRICE.pro }], start_date: PERIOD_END },
        ],
      },
    });
    const summary = await runFounderMigration(deps, { dryRun: false });

    expect(summary.dbCompleted).toBe(1);
    expect(summary.alreadyComplete).toBe(0);
    expect(summary.reconciled).toBe(0);
    // Stripe already correct — never touched again.
    expect(writes.schedulesCreated).toEqual([]);
    expect(writes.scheduleUpdates).toEqual([]);
    // The local bookkeeping DOES land this time.
    expect(writes.recordFounderToPro).toEqual([
      {
        userId: 'user_jono',
        stripeSubscriptionId: 'sub_jono',
        stripeScheduleId: 'sched_partial',
        scheduledPriceId: PRICE.pro,
        scheduledChangeDate: new Date(PERIOD_END * 1000),
      },
    ]);
  });

  it('A-9 P1 an existing schedule that never targeted Pro is fixed in place, then the local write completes', async () => {
    // createScheduleFromSubscription succeeded on a prior run but the phase-update call
    // failed, so the schedule exists with only its original (Founder, no end date) phase.
    const seed = founderSeed(
      { scheduleId: 'sched_stuck' },
      { subscriptionTier: 'founder', stripeScheduleId: null },
    );
    const { deps, writes } = seededDeps(seed, {
      sched_stuck: {
        phases: [{ items: [{ price: PRICE.founder }], start_date: PHASE_START }],
      },
    });
    const summary = await runFounderMigration(deps, { dryRun: false });

    expect(summary.reconciled).toBe(1);
    expect(summary.dbCompleted).toBe(0);
    expect(summary.alreadyComplete).toBe(0);
    // The existing phase gets an end_date, then a Pro phase is appended — not a brand-new schedule.
    expect(writes.schedulesCreated).toEqual([]);
    expect(writes.scheduleUpdates).toEqual([
      {
        scheduleId: 'sched_stuck',
        phases: [
          { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END },
          { items: [{ price: PRICE.pro }], start_date: PERIOD_END },
        ],
      },
    ]);
    expect(writes.recordFounderToPro).toEqual([
      {
        userId: 'user_jono',
        stripeSubscriptionId: 'sub_jono',
        stripeScheduleId: 'sched_stuck',
        scheduledPriceId: PRICE.pro,
        scheduledChangeDate: new Date(PERIOD_END * 1000),
      },
    ]);
  });

  it('A-9 P1 --dry-run on a partial-failure retry reports the plan but writes nothing', async () => {
    const seed = founderSeed(
      { scheduleId: 'sched_partial' },
      { subscriptionTier: 'founder', stripeScheduleId: null },
    );
    const { deps, writes } = seededDeps(seed, {
      sched_partial: {
        phases: [
          { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END },
          { items: [{ price: PRICE.pro }], start_date: PERIOD_END },
        ],
      },
    });
    const summary = await runFounderMigration(deps, { dryRun: true });

    expect(summary.dbCompleted).toBe(1);
    expect(writes.recordFounderToPro).toEqual([]);
    expect(writes.scheduleUpdates).toEqual([]);
  });

  it('A-9 never rewrites a row whose live Stripe price is not Founder', async () => {
    const { deps, writes } = seededDeps(founderSeed({ currentPriceId: PRICE.pro }));
    const summary = await runFounderMigration(deps, { dryRun: false });

    expect(summary.skippedNotOnFounderPrice).toBe(1);
    expect(writes.schedulesCreated).toEqual([]);
    expect(writes.recordFounderToPro).toEqual([]);
  });
});
