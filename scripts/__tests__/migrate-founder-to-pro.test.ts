/**
 * A-9 — scripts/migrate-founder-to-pro.ts against a seeded Founder row.
 *
 * Round 3 (independent review + point-guard structural redesign): this
 * migration handles exactly ONE known account. The old design classified an
 * existing schedule as "already correct" by NEGATIVE match (nothing flagged
 * wrong); every review round found another shape that slipped through. This
 * suite instead asserts POSITIVE match only: (A) create, (B) an EXACT
 * byte-for-byte match is recognised as done, (C) everything else — a wrong
 * quantity, a second item, a mid-period price switch, `end_behavior:
 * 'cancel'`, an extra phase, a changed discount, and more — REFUSES with
 * zero Stripe writes and zero DB writes.
 *
 * The store and Stripe seams are in-memory fakes that RECORD every write, so
 * "no writes" assertions are real, not vacuous.
 */
import { describe, it, expect } from 'vitest';
import {
  runFounderMigration,
  planFounderAction,
  expectedProSchedulePhases,
  planExistingScheduleAction,
  createStripeAdapter,
  type FounderSubscriptionRow,
  type LegacyBusinessRow,
  type MigrationStore,
  type MigrationStripe,
  type StripeSubscriptionView,
  type SchedulePhase,
  type ExistingSchedule,
} from '../migrate-founder-to-pro';

const PRICE = { founder: 'price_founder_50', pro: 'price_pro_15', legacyBusiness: 'price_business_100' };
const PERIOD_END = 1_790_000_000; // unix seconds
const PHASE_START = 1_787_000_000;

const EXPECTED_PHASES: SchedulePhase[] = [
  { items: [{ price: PRICE.founder, quantity: 1 }], start_date: PHASE_START, end_date: PERIOD_END, discounts: [] },
  { items: [{ price: PRICE.pro, quantity: 1 }], start_date: PERIOD_END, discounts: [] },
];

function liveSub(overrides: Partial<StripeSubscriptionView> = {}): StripeSubscriptionView {
  return {
    id: 'sub_jono',
    scheduleId: null,
    status: 'active',
    items: [{ price: PRICE.founder, quantity: 1 }],
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    cancelAt: null,
    discounts: [],
    ...overrides,
  };
}

interface Seed {
  founderRows?: FounderSubscriptionRow[];
  legacyRows?: LegacyBusinessRow[];
  stripeSubs?: Record<string, StripeSubscriptionView>;
}

function seededDeps(seed: Seed, schedules: Record<string, ExistingSchedule> = {}) {
  const writes = {
    recordFounderToPro: [] as Parameters<MigrationStore['recordFounderToPro']>[0][],
    markGrandfathered: [] as string[],
    schedulesCreated: [] as string[],
    scheduleUpdates: [] as { scheduleId: string; phases: SchedulePhase[]; endBehavior: string }[],
    scheduleReads: [] as string[],
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
    updateSchedulePhases: async (scheduleId, phases, endBehavior) => {
      writes.scheduleUpdates.push({ scheduleId, phases, endBehavior });
    },
    retrieveSchedule: async (scheduleId) => {
      writes.scheduleReads.push(scheduleId);
      const schedule = schedules[scheduleId];
      if (!schedule) throw new Error(`no fake schedule ${scheduleId}`);
      return schedule;
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
      sub_jono: liveSub(overrides),
    },
  };
}

describe('planFounderAction (pure)', () => {
  const row: FounderSubscriptionRow = {
    userId: 'u', stripeSubscriptionId: 'sub', status: 'active',
    subscriptionTier: 'founder', stripeScheduleId: null,
  };

  it('(A) recognised start state — single Founder item, quantity 1, active, not cancelling, no schedule — creates a schedule', () => {
    expect(planFounderAction(row, liveSub({ id: 'sub' }), PRICE))
      .toEqual({ kind: 'create-schedule', userId: 'u', stripeSubscriptionId: 'sub' });
  });

  it('a subscription already carrying a schedule is routed to check-existing-schedule, not re-created', () => {
    expect(planFounderAction(row, liveSub({ id: 'sub', scheduleId: 'sched_1' }), PRICE))
      .toEqual({ kind: 'check-existing-schedule', userId: 'u', stripeSubscriptionId: 'sub', scheduleId: 'sched_1' });
  });

  it('is a benign not-on-founder-price skip when the live price is not the Founder price (stale DB row)', () => {
    expect(planFounderAction(row, liveSub({ id: 'sub', items: [{ price: PRICE.pro, quantity: 1 }] }), PRICE))
      .toEqual({ kind: 'not-on-founder-price', userId: 'u', stripeSubscriptionId: 'sub', currentPriceId: PRICE.pro });
  });

  it('(C) REFUSES a Founder subscription set to cancel at period end', () => {
    const action = planFounderAction(row, liveSub({ id: 'sub', cancelAtPeriodEnd: true }), PRICE);
    expect(action.kind).toBe('refuse');
    expect((action as { reason: string }).reason).toMatch(/cancel/i);
  });

  it('(C) REFUSES a Founder subscription with a cancelAt timestamp set, even if cancelAtPeriodEnd is false', () => {
    const action = planFounderAction(row, liveSub({ id: 'sub', cancelAt: PERIOD_END + 100 }), PRICE);
    expect(action.kind).toBe('refuse');
  });

  it('(C) REFUSES a cancelling subscription even if it already carries a schedule', () => {
    const action = planFounderAction(row, liveSub({ id: 'sub', scheduleId: 'sched_1', cancelAtPeriodEnd: true }), PRICE);
    expect(action.kind).toBe('refuse');
  });

  it('(C) REFUSES a Founder-priced item with quantity other than 1 — the reviewer\'s "Pro with quantity 5" class of defect, checked at the subscription level too', () => {
    const action = planFounderAction(row, liveSub({ id: 'sub', items: [{ price: PRICE.founder, quantity: 5 }] }), PRICE);
    expect(action.kind).toBe('refuse');
  });

  it('(C) REFUSES a subscription with a second item, even if the first is the Founder price at quantity 1', () => {
    const action = planFounderAction(
      row,
      liveSub({ id: 'sub', items: [{ price: PRICE.founder, quantity: 1 }, { price: 'price_addon', quantity: 1 }] }),
      PRICE,
    );
    expect(action.kind).toBe('refuse');
  });

  it('(C) REFUSES a subscription whose Stripe status is not active (e.g. past_due)', () => {
    const action = planFounderAction(row, liveSub({ id: 'sub', status: 'past_due' }), PRICE);
    expect(action.kind).toBe('refuse');
  });
});

describe('expectedProSchedulePhases (pure) — the one builder both CREATE and the done-state check use', () => {
  it('keeps the Founder price at quantity 1 until period end, carrying the subscription\'s current discounts, then Pro at quantity 1 with no discounts', () => {
    const phases = expectedProSchedulePhases(
      liveSub({ discounts: [{ coupon: 'promo_50off' }] }),
      PHASE_START,
      PRICE,
    );
    expect(phases).toEqual([
      { items: [{ price: PRICE.founder, quantity: 1 }], start_date: PHASE_START, end_date: PERIOD_END, discounts: [{ coupon: 'promo_50off' }] },
      { items: [{ price: PRICE.pro, quantity: 1 }], start_date: PERIOD_END, discounts: [] },
    ]);
  });
});

describe('planExistingScheduleAction (pure) — positive match only; everything not an exact match REFUSES', () => {
  const row: FounderSubscriptionRow = {
    userId: 'u', stripeSubscriptionId: 'sub', status: 'active',
    subscriptionTier: 'founder', stripeScheduleId: null,
  };
  const live = liveSub({ id: 'sub', scheduleId: 'sched_1' });
  const matchingSchedule: ExistingSchedule = { phases: EXPECTED_PHASES, endBehavior: 'release' };

  it('(B) both Stripe and the local write already correct → complete (true no-op)', () => {
    const result = planExistingScheduleAction(
      { ...row, subscriptionTier: 'pro', stripeScheduleId: 'sched_1' },
      live, 'sched_1', matchingSchedule, PRICE,
    );
    expect(result).toEqual({ kind: 'complete' });
  });

  it('(B) Stripe already exactly matches but the local write is missing → record-local', () => {
    const result = planExistingScheduleAction(row, live, 'sched_1', matchingSchedule, PRICE);
    expect(result).toEqual({ kind: 'record-local' });
  });

  it('(B) a mismatched local schedule id (points at a stale/different schedule) is treated as incomplete → record-local', () => {
    const result = planExistingScheduleAction(
      { ...row, subscriptionTier: 'pro', stripeScheduleId: 'sched_stale' },
      live, 'sched_1', matchingSchedule, PRICE,
    );
    expect(result).toEqual({ kind: 'record-local' });
  });

  it('(C) REFUSES a schedule with no phases at all, rather than crashing on phases[0]', () => {
    const result = planExistingScheduleAction(row, live, 'sched_1', { phases: [], endBehavior: 'release' }, PRICE);
    expect(result.kind).toBe('refuse');
  });

  it('(C) REFUSES a mid-period switch to the legacy Business price — reviewer-cited shape: [founder→T1, business T1→cpe, pro cpe→]', () => {
    const T1 = PERIOD_END - 500;
    const midPeriodSwitch: SchedulePhase[] = [
      { items: [{ price: PRICE.founder, quantity: 1 }], start_date: PHASE_START, end_date: T1, discounts: [] },
      { items: [{ price: PRICE.legacyBusiness, quantity: 1 }], start_date: T1, end_date: PERIOD_END, discounts: [] },
      { items: [{ price: PRICE.pro, quantity: 1 }], start_date: PERIOD_END, discounts: [] },
    ];
    const result = planExistingScheduleAction(row, live, 'sched_1', { phases: midPeriodSwitch, endBehavior: 'release' }, PRICE);
    expect(result.kind).toBe('refuse');
  });

  it('(C) REFUSES a Pro phase with quantity 5 instead of 1', () => {
    const wrongQuantity: SchedulePhase[] = [
      EXPECTED_PHASES[0],
      { items: [{ price: PRICE.pro, quantity: 5 }], start_date: PERIOD_END, discounts: [] },
    ];
    const result = planExistingScheduleAction(row, live, 'sched_1', { phases: wrongQuantity, endBehavior: 'release' }, PRICE);
    expect(result.kind).toBe('refuse');
  });

  it('(C) REFUSES a Pro phase carrying a second item', () => {
    const secondItem: SchedulePhase[] = [
      EXPECTED_PHASES[0],
      { items: [{ price: PRICE.pro, quantity: 1 }, { price: 'price_addon', quantity: 1 }], start_date: PERIOD_END, discounts: [] },
    ];
    const result = planExistingScheduleAction(row, live, 'sched_1', { phases: secondItem, endBehavior: 'release' }, PRICE);
    expect(result.kind).toBe('refuse');
  });

  it('(C) REFUSES end_behavior "cancel" even when every phase matches exactly', () => {
    const result = planExistingScheduleAction(row, live, 'sched_1', { phases: EXPECTED_PHASES, endBehavior: 'cancel' }, PRICE);
    expect(result.kind).toBe('refuse');
  });

  it('(C) REFUSES an extra third phase appended after the expected two', () => {
    const extraPhase: SchedulePhase[] = [
      ...EXPECTED_PHASES,
      { items: [{ price: 'price_stale_downgrade', quantity: 1 }], start_date: PERIOD_END + 10_000, discounts: [] },
    ];
    const result = planExistingScheduleAction(row, live, 'sched_1', { phases: extraPhase, endBehavior: 'release' }, PRICE);
    expect(result.kind).toBe('refuse');
  });

  it('(C) REFUSES when the Founder phase\'s discount no longer matches the subscription\'s current discount', () => {
    const changedDiscount: SchedulePhase[] = [
      { ...EXPECTED_PHASES[0], discounts: [{ coupon: 'a_different_promo' }] },
      EXPECTED_PHASES[1],
    ];
    // live has no discounts (subscription's current state), schedule phase has one — mismatch.
    const result = planExistingScheduleAction(row, live, 'sched_1', { phases: changedDiscount, endBehavior: 'release' }, PRICE);
    expect(result.kind).toBe('refuse');
  });

  it('(C) REFUSES a Founder phase whose end_date extends past period end (one more billed Founder period)', () => {
    const laterEnd = PERIOD_END + 500;
    const overrun: SchedulePhase[] = [
      { items: [{ price: PRICE.founder, quantity: 1 }], start_date: PHASE_START, end_date: laterEnd, discounts: [] },
      { items: [{ price: PRICE.pro, quantity: 1 }], start_date: laterEnd, discounts: [] },
    ];
    const result = planExistingScheduleAction(row, live, 'sched_1', { phases: overrun, endBehavior: 'release' }, PRICE);
    expect(result.kind).toBe('refuse');
  });
});

describe('createStripeAdapter().retrieveSchedule', () => {
  it('reads end_behavior and normalizes each phase\'s discounts and item quantities explicitly', async () => {
    const fakeStripe = {
      subscriptionSchedules: {
        retrieve: async () => ({
          end_behavior: 'release',
          phases: [
            {
              start_date: PHASE_START,
              end_date: PERIOD_END,
              items: [{ price: PRICE.founder, quantity: 1 }],
              discounts: [{ coupon: 'promo_50off', discount: null, promotion_code: null }],
            },
            {
              start_date: PERIOD_END,
              end_date: undefined,
              items: [{ price: { id: PRICE.pro }, quantity: 1 }],
              discounts: [],
            },
          ],
        }),
      },
    } as unknown as import('stripe').Stripe;
    const adapter = createStripeAdapter(fakeStripe);
    const schedule = await adapter.retrieveSchedule('sched_1');
    expect(schedule).toEqual({
      endBehavior: 'release',
      phases: [
        {
          items: [{ price: PRICE.founder, quantity: 1 }],
          start_date: PHASE_START,
          end_date: PERIOD_END,
          discounts: [{ coupon: 'promo_50off', discount: undefined, promotion_code: undefined }],
        },
        {
          items: [{ price: PRICE.pro, quantity: 1 }],
          start_date: PERIOD_END,
          end_date: undefined,
          discounts: [],
        },
      ],
    });
  });
});

describe('createStripeAdapter().retrieveSubscription', () => {
  it('carries every item, status, cancellation flags, and discount ids through', async () => {
    const fakeStripe = {
      subscriptions: {
        retrieve: async () => ({
          id: 'sub_1',
          schedule: null,
          status: 'active',
          items: { data: [{ price: { id: PRICE.founder }, quantity: 1, current_period_end: PERIOD_END }] },
          cancel_at_period_end: false,
          cancel_at: null,
          discounts: ['di_abc123'],
        }),
      },
    } as unknown as import('stripe').Stripe;
    const adapter = createStripeAdapter(fakeStripe);
    const sub = await adapter.retrieveSubscription('sub_1');
    expect(sub).toEqual({
      id: 'sub_1',
      scheduleId: null,
      status: 'active',
      items: [{ price: PRICE.founder, quantity: 1 }],
      currentPeriodEnd: PERIOD_END,
      cancelAtPeriodEnd: false,
      cancelAt: null,
      discounts: [{ discount: 'di_abc123' }],
    });
  });
});

describe('runFounderMigration against a seeded Founder row', () => {
  it('(A) --dry-run plans the create and the grandfathering but writes nothing to Stripe or the DB', async () => {
    const { deps, writes, lines } = seededDeps(founderSeed());
    const summary = await runFounderMigration(deps, { dryRun: true });

    expect(summary).toEqual({
      dryRun: true,
      founderRows: 1,
      created: 1,
      alreadyComplete: 0,
      recorded: 0,
      refused: 0,
      notOnFounderPrice: 0,
      failed: 0,
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

  it('(A) executes: creates the schedule Founder → Pro at period end, writes tier pro now with the schedule recorded, and grandfathers the $100 Business user once', async () => {
    const { deps, writes } = seededDeps(founderSeed());
    const summary = await runFounderMigration(deps, { dryRun: false });

    expect(summary.created).toBe(1);
    expect(writes.schedulesCreated).toEqual(['sub_jono']);
    expect(writes.scheduleUpdates).toEqual([{ scheduleId: 'sched_for_sub_jono', phases: EXPECTED_PHASES, endBehavior: 'release' }]);
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

  it('(B) a fully-completed row (Stripe exactly matches, local write already landed) is a true no-op on retry', async () => {
    const seed = founderSeed(
      { scheduleId: 'sched_done' },
      { subscriptionTier: 'pro', stripeScheduleId: 'sched_done' },
    );
    const { deps, writes } = seededDeps(seed, { sched_done: { phases: EXPECTED_PHASES, endBehavior: 'release' } });
    const summary = await runFounderMigration(deps, { dryRun: false });

    expect(summary.alreadyComplete).toBe(1);
    expect(summary.recorded).toBe(0);
    expect(summary.created).toBe(0);
    expect(writes.schedulesCreated).toEqual([]);
    expect(writes.scheduleUpdates).toEqual([]);
    expect(writes.recordFounderToPro).toEqual([]);
  });

  it('(B) retry after Stripe succeeded but the script crashed before recordFounderToPro: completes the local write without touching Stripe again', async () => {
    // The schedule already exactly matches (a prior run's create+updateSchedulePhases
    // succeeded), but the row still says 'founder' with no local schedule id
    // (recordFounderToPro never ran) — this is the real founder account the
    // P1 bug would leave stuck on Free.
    const seed = founderSeed(
      { scheduleId: 'sched_partial' },
      { subscriptionTier: 'founder', stripeScheduleId: null },
    );
    const { deps, writes } = seededDeps(seed, { sched_partial: { phases: EXPECTED_PHASES, endBehavior: 'release' } });
    const summary = await runFounderMigration(deps, { dryRun: false });

    expect(summary.recorded).toBe(1);
    expect(summary.alreadyComplete).toBe(0);
    expect(summary.refused).toBe(0);
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

  it('(B) --dry-run on a partial-failure retry reports the plan but writes nothing', async () => {
    const seed = founderSeed(
      { scheduleId: 'sched_partial' },
      { subscriptionTier: 'founder', stripeScheduleId: null },
    );
    const { deps, writes } = seededDeps(seed, { sched_partial: { phases: EXPECTED_PHASES, endBehavior: 'release' } });
    const summary = await runFounderMigration(deps, { dryRun: true });

    expect(summary.recorded).toBe(1);
    expect(writes.recordFounderToPro).toEqual([]);
    expect(writes.scheduleUpdates).toEqual([]);
  });

  it('never rewrites a row whose live Stripe price is not Founder', async () => {
    const { deps, writes } = seededDeps(founderSeed({ items: [{ price: PRICE.pro, quantity: 1 }] }));
    const summary = await runFounderMigration(deps, { dryRun: false });

    expect(summary.notOnFounderPrice).toBe(1);
    expect(writes.schedulesCreated).toEqual([]);
    expect(writes.recordFounderToPro).toEqual([]);
  });

  it('(C) an existing schedule that does not exactly match is REFUSED end-to-end — zero Stripe writes, zero DB writes — and does not abort the run', async () => {
    // The reviewer's mid-period-Business-switch shape, seeded live.
    const T1 = PERIOD_END - 500;
    const seed = founderSeed(
      { scheduleId: 'sched_business_switch' },
      { subscriptionTier: 'founder', stripeScheduleId: null },
    );
    const { deps, writes, lines } = seededDeps(seed, {
      sched_business_switch: {
        endBehavior: 'release',
        phases: [
          { items: [{ price: PRICE.founder, quantity: 1 }], start_date: PHASE_START, end_date: T1, discounts: [] },
          { items: [{ price: PRICE.legacyBusiness, quantity: 1 }], start_date: T1, end_date: PERIOD_END, discounts: [] },
          { items: [{ price: PRICE.pro, quantity: 1 }], start_date: PERIOD_END, discounts: [] },
        ],
      },
    });
    const summary = await runFounderMigration(deps, { dryRun: false });

    expect(summary.refused).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.recorded).toBe(0);
    expect(summary.alreadyComplete).toBe(0);
    expect(writes.scheduleUpdates).toEqual([]);
    expect(writes.recordFounderToPro).toEqual([]);
    expect(lines.some((l) => l.includes('user_jono') && l.includes('REFUSED'))).toBe(true);
    // Step 2 still ran despite the step-1 refusal.
    expect(writes.markGrandfathered).toEqual(['user_biz100']);
    expect(summary.grandfathered).toBe(1);
  });

  it('(C) a cancelling Founder subscription is refused end-to-end — zero Stripe writes, zero DB writes, never reads a schedule', async () => {
    const seed = founderSeed({ cancelAtPeriodEnd: true });
    const { deps, writes, lines } = seededDeps(seed);
    const summary = await runFounderMigration(deps, { dryRun: false });

    expect(summary.refused).toBe(1);
    expect(summary.created).toBe(0);
    expect(writes.schedulesCreated).toEqual([]);
    expect(writes.scheduleUpdates).toEqual([]);
    expect(writes.scheduleReads).toEqual([]);
    expect(writes.recordFounderToPro).toEqual([]);
    expect(lines.some((l) => l.includes('user_jono') && l.includes('REFUSED') && l.toLowerCase().includes('cancel'))).toBe(true);
  });
});
