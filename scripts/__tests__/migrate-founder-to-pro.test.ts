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

function seededDeps(seed: Seed) {
  const writes = {
    recordFounderToPro: [] as Parameters<MigrationStore['recordFounderToPro']>[0][],
    markGrandfathered: [] as string[],
    schedulesCreated: [] as string[],
    scheduleUpdates: [] as { scheduleId: string; phases: SchedulePhase[] }[],
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
  };
  const lines: string[] = [];
  return {
    deps: { store, stripe, priceIds: { founder: PRICE.founder, pro: PRICE.pro }, log: (l: string) => lines.push(l) },
    writes,
    lines,
  };
}

/** The Northwind-era fixture: Jono on Founder, one legacy $100 Business user, one Pro user. */
function founderSeed(overrides: Partial<StripeSubscriptionView> = {}): Seed {
  return {
    founderRows: [{ userId: 'user_jono', stripeSubscriptionId: 'sub_jono', status: 'active' }],
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
  const row: FounderSubscriptionRow = { userId: 'u', stripeSubscriptionId: 'sub', status: 'active' };

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

describe('runFounderMigration against a seeded Founder row', () => {
  it('A-9 --dry-run plans the move and the grandfathering but writes nothing to Stripe or the DB', async () => {
    const { deps, writes, lines } = seededDeps(founderSeed());
    const summary = await runFounderMigration(deps, { dryRun: true });

    expect(summary).toEqual({
      dryRun: true,
      founderRows: 1,
      scheduled: 1,
      alreadyScheduled: 0,
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

  it('A-9 a second run is a no-op for a subscription that already carries the schedule', async () => {
    const { deps, writes } = seededDeps(founderSeed({ scheduleId: 'sched_for_sub_jono' }));
    const summary = await runFounderMigration(deps, { dryRun: false });

    expect(summary.alreadyScheduled).toBe(1);
    expect(summary.scheduled).toBe(0);
    expect(writes.schedulesCreated).toEqual([]);
    expect(writes.recordFounderToPro).toEqual([]);
  });

  it('A-9 never rewrites a row whose live Stripe price is not Founder', async () => {
    const { deps, writes } = seededDeps(founderSeed({ currentPriceId: PRICE.pro }));
    const summary = await runFounderMigration(deps, { dryRun: false });

    expect(summary.skippedNotOnFounderPrice).toBe(1);
    expect(writes.schedulesCreated).toEqual([]);
    expect(writes.recordFounderToPro).toEqual([]);
  });
});
