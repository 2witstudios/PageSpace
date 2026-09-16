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
  createStripeAdapter,
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

  it('P1 (independent review) REFUSES a Founder subscription set to cancel at period end — never bill one more Pro period to someone leaving', () => {
    const action = planFounderAction(
      row,
      { id: 'sub', scheduleId: null, currentPriceId: PRICE.founder, currentPeriodEnd: PERIOD_END, cancelAtPeriodEnd: true },
      PRICE,
    );
    expect(action.kind).toBe('refuse');
    expect((action as { reason: string }).reason).toMatch(/cancel/i);
  });

  it('P1 (independent review) REFUSES a Founder subscription with a cancelAt timestamp set, even if cancelAtPeriodEnd is false', () => {
    const action = planFounderAction(
      row,
      { id: 'sub', scheduleId: null, currentPriceId: PRICE.founder, currentPeriodEnd: PERIOD_END, cancelAtPeriodEnd: false, cancelAt: PERIOD_END + 100 },
      PRICE,
    );
    expect(action.kind).toBe('refuse');
  });

  it('P1 (independent review) REFUSES a cancelling subscription even if it already carries a schedule', () => {
    const action = planFounderAction(
      row,
      { id: 'sub', scheduleId: 'sched_1', currentPriceId: PRICE.founder, currentPeriodEnd: PERIOD_END, cancelAtPeriodEnd: true },
      PRICE,
    );
    expect(action.kind).toBe('refuse');
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
  it('A-9 P1 is true when the phase active at period end is Pro', () => {
    expect(scheduleTargetsPro(
      [{ items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END }, { items: [{ price: PRICE.pro }], start_date: PERIOD_END }],
      PERIOD_END,
      PRICE.pro,
    )).toBe(true);
  });

  it('A-9 P1 is false when the phase active at period end is not Pro (a schedule created but never updated)', () => {
    expect(scheduleTargetsPro([{ items: [{ price: PRICE.founder }], start_date: PHASE_START }], PERIOD_END, PRICE.pro)).toBe(false);
  });

  it('A-9 P1 is false for an empty phase list', () => {
    expect(scheduleTargetsPro([], PERIOD_END, PRICE.pro)).toBe(false);
  });

  it('P2 (independent review) is false when Pro is the LAST phase but an intermediate non-Pro phase is the one actually active at period end', () => {
    // [founder -> cpe, business cpe -> X, pro X -> ]: Pro is last, but the
    // phase active AT cpe is business. Checking only the last phase would
    // wrongly call this schedule "already correct".
    const X = PERIOD_END + 500;
    expect(scheduleTargetsPro(
      [
        { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END },
        { items: [{ price: PRICE.legacyBusiness }], start_date: PERIOD_END, end_date: X },
        { items: [{ price: PRICE.pro }], start_date: X },
      ],
      PERIOD_END,
      PRICE.pro,
    )).toBe(false);
  });

  it('P2 (independent review, round 2) is false when Pro sits exactly AT the boundary but something non-Pro is queued after it — not durably on Pro', () => {
    // [founder -> cpe, pro cpe -> X, other X -> ]: Pro is at the boundary,
    // but the schedule does not STAY on Pro.
    const X = PERIOD_END + 500;
    expect(scheduleTargetsPro(
      [
        { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END },
        { items: [{ price: PRICE.pro }], start_date: PERIOD_END, end_date: X },
        { items: [{ price: PRICE.legacyBusiness }], start_date: X },
      ],
      PERIOD_END,
      PRICE.pro,
    )).toBe(false);
  });

  it('P2 (independent review, round 2) is false when the phase active at the boundary EXTENDS PAST it — one more Founder period would still be billed', () => {
    // [founder PS -> cpe+P, pro cpe+P -> ]: the active phase at cpe is
    // Founder, and it does not end until cpe+P.
    const laterEnd = PERIOD_END + 500;
    expect(scheduleTargetsPro(
      [
        { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: laterEnd },
        { items: [{ price: PRICE.pro }], start_date: laterEnd },
      ],
      PERIOD_END,
      PRICE.pro,
    )).toBe(false);
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

  it('P2 (codex) drops a future-dated tail phase instead of backdating it — a phase starting at/after period end would otherwise get end_date <= start_date, which Stripe rejects', () => {
    // The schedule already has a queued phase that starts AT the period end
    // (e.g. a stale/unrelated future change) — the naive "cap the last
    // phase's end_date" approach would set end_date === start_date on that
    // phase, a zero-length phase Stripe refuses.
    const result = reconcilePhasesToPro(
      sub,
      [
        { items: [{ price: PRICE.founder }], start_date: PHASE_START },
        { items: [{ price: 'price_some_other_plan' }], start_date: PERIOD_END },
      ],
      PRICE.pro,
    );
    expect(result).toEqual([
      { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END },
      { items: [{ price: PRICE.pro }], start_date: PERIOD_END },
    ]);
  });

  it('P2 (codex) drops an entire future tail of multiple phases, capping the phase actually active at the boundary', () => {
    const FAR_FUTURE = PERIOD_END + 1_000_000;
    const result = reconcilePhasesToPro(
      sub,
      [
        { items: [{ price: 'price_trial' }], start_date: 1, end_date: PHASE_START },
        { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END + 500 },
        { items: [{ price: 'price_stale_downgrade' }], start_date: PERIOD_END + 500, end_date: FAR_FUTURE },
        { items: [{ price: 'price_stale_downgrade_2' }], start_date: FAR_FUTURE },
      ],
      PRICE.pro,
    );
    expect(result).toEqual([
      { items: [{ price: 'price_trial' }], start_date: 1, end_date: PHASE_START },
      { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END },
      { items: [{ price: PRICE.pro }], start_date: PERIOD_END },
    ]);
  });

  it('P2 (independent review) refuses a schedule whose every phase already starts at/after period end, rather than capping the first phase into an invalid (end_date <= start_date) one', () => {
    expect(() =>
      reconcilePhasesToPro(
        sub,
        [{ items: [{ price: 'price_some_other_plan' }], start_date: PERIOD_END }],
        PRICE.pro,
      ),
    ).toThrow(/no phase active at period end/);
  });

  it('P2 (independent review) preserves the capped phase\'s discounts and item quantity — a lossy round-trip would otherwise drop a founder\'s promo code', () => {
    const result = reconcilePhasesToPro(
      sub,
      [{ items: [{ price: PRICE.founder, quantity: 2 }], start_date: PHASE_START, discounts: [{ coupon: 'promo_50off' }] }],
      PRICE.pro,
    );
    expect(result).toEqual([
      { items: [{ price: PRICE.founder, quantity: 2 }], start_date: PHASE_START, end_date: PERIOD_END, discounts: [{ coupon: 'promo_50off' }] },
      { items: [{ price: PRICE.pro }], start_date: PERIOD_END },
    ]);
  });

  it('P2 (independent review, round 2) truncates an active phase that extends past period end, rather than leaving it to bill one more period', () => {
    const laterEnd = PERIOD_END + 500;
    const result = reconcilePhasesToPro(
      sub,
      [{ items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: laterEnd }],
      PRICE.pro,
    );
    expect(result).toEqual([
      { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END },
      { items: [{ price: PRICE.pro }], start_date: PERIOD_END },
    ]);
  });
});

describe('createStripeAdapter().retrieveSchedulePhases (P2, independent review: lossy round-trip)', () => {
  it('carries through each phase\'s discounts and each item\'s quantity, not just price/start/end', async () => {
    const fakeStripe = {
      subscriptionSchedules: {
        retrieve: async () => ({
          phases: [
            {
              start_date: PHASE_START,
              end_date: PERIOD_END,
              items: [{ price: PRICE.founder, quantity: 3 }],
              discounts: [{ coupon: 'promo_50off', discount: null, promotion_code: null }],
            },
          ],
        }),
      },
    } as unknown as import('stripe').Stripe;
    const adapter = createStripeAdapter(fakeStripe);
    const phases = await adapter.retrieveSchedulePhases('sched_1');
    expect(phases).toEqual([
      {
        items: [{ price: PRICE.founder, quantity: 3 }],
        start_date: PHASE_START,
        end_date: PERIOD_END,
        discounts: [{ coupon: 'promo_50off', discount: undefined, promotion_code: undefined }],
      },
    ]);
  });

  it('omits discounts entirely when the phase has none, rather than writing back an empty array', async () => {
    const fakeStripe = {
      subscriptionSchedules: {
        retrieve: async () => ({
          phases: [
            {
              start_date: PHASE_START,
              end_date: PERIOD_END,
              items: [{ price: PRICE.pro, quantity: 1 }],
              discounts: [],
            },
          ],
        }),
      },
    } as unknown as import('stripe').Stripe;
    const adapter = createStripeAdapter(fakeStripe);
    const phases = await adapter.retrieveSchedulePhases('sched_1');
    expect(phases[0].discounts).toBeUndefined();
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

  it('P2 (independent review) Pro as the LAST phase with a non-Pro phase active at period end is fix-schedule, not db-only — the schedule is not actually correct yet', () => {
    const X = PERIOD_END + 500;
    const proLastButNotAtBoundary: SchedulePhase[] = [
      { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END },
      { items: [{ price: 'price_business_100' }], start_date: PERIOD_END, end_date: X },
      { items: [{ price: PRICE.pro }], start_date: X },
    ];
    const result = planScheduleReconciliation(row, live, 'sched_1', proLastButNotAtBoundary, PRICE.pro);
    expect(result.kind).toBe('fix-schedule');
  });

  it('P2 (independent review, round 2) Pro AT the boundary with a non-Pro tail after it is fix-schedule — the schedule does not durably stay on Pro', () => {
    const X = PERIOD_END + 500;
    const proAtBoundaryWithTail: SchedulePhase[] = [
      { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: PERIOD_END },
      { items: [{ price: PRICE.pro }], start_date: PERIOD_END, end_date: X },
      { items: [{ price: 'price_business_100' }], start_date: X },
    ];
    const result = planScheduleReconciliation(row, live, 'sched_1', proAtBoundaryWithTail, PRICE.pro);
    expect(result.kind).toBe('fix-schedule');
  });

  it('P2 (independent review, round 2) a Founder phase extending past period end is fix-schedule — one more Founder period would otherwise be billed', () => {
    const laterEnd = PERIOD_END + 500;
    const founderExtendsPastBoundary: SchedulePhase[] = [
      { items: [{ price: PRICE.founder }], start_date: PHASE_START, end_date: laterEnd },
      { items: [{ price: PRICE.pro }], start_date: laterEnd },
    ];
    const result = planScheduleReconciliation(row, live, 'sched_1', founderExtendsPastBoundary, PRICE.pro);
    expect(result.kind).toBe('fix-schedule');
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
      failed: 0,
      refused: 0,
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

  it('P2 (independent review) a malformed schedule (no phase active at the boundary) is REFUSED, not guessed at — and does not abort the run', async () => {
    // The schedule's only phase already starts AT the period end — there is
    // no phase active at the boundary to cap. planScheduleReconciliation
    // (round 2) now detects this itself and returns 'refuse' rather than
    // calling reconcilePhasesToPro and catching its throw — a typed refusal,
    // not an error. Before the original P2 fix this threw out of the whole
    // for-loop, leaving every later founder row AND step 2 (grandfathering)
    // unprocessed.
    const seed = founderSeed(
      { scheduleId: 'sched_malformed' },
      { subscriptionTier: 'founder', stripeScheduleId: null },
    );
    const { deps, writes, lines } = seededDeps(seed, {
      sched_malformed: {
        phases: [{ items: [{ price: 'price_some_other_plan' }], start_date: PERIOD_END }],
      },
    });
    const summary = await runFounderMigration(deps, { dryRun: false });

    expect(summary.refused).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.reconciled).toBe(0);
    expect(summary.dbCompleted).toBe(0);
    expect(writes.scheduleUpdates).toEqual([]);
    expect(writes.recordFounderToPro).toEqual([]);
    expect(lines.some((l) => l.includes('user_jono') && l.includes('REFUSED'))).toBe(true);
    // Step 2 still ran despite the step-1 refusal.
    expect(writes.markGrandfathered).toEqual(['user_biz100']);
    expect(summary.grandfathered).toBe(1);
  });

  it('P1 (independent review) a cancelling Founder subscription is refused end-to-end — zero Stripe writes, zero DB writes', async () => {
    const seed = founderSeed({ cancelAtPeriodEnd: true });
    const { deps, writes, lines } = seededDeps(seed);
    const summary = await runFounderMigration(deps, { dryRun: false });

    expect(summary.refused).toBe(1);
    expect(summary.scheduled).toBe(0);
    expect(writes.schedulesCreated).toEqual([]);
    expect(writes.scheduleUpdates).toEqual([]);
    expect(writes.schedulePhaseReads).toEqual([]);
    expect(writes.recordFounderToPro).toEqual([]);
    expect(lines.some((l) => l.includes('user_jono') && l.includes('REFUSED') && l.toLowerCase().includes('cancel'))).toBe(true);
  });
});
