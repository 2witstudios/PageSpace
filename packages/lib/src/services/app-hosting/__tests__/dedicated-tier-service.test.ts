import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assert } from '../../sandbox/__tests__/riteway';

/**
 * A db double recording every UPDATE's SET payload and the row it matched.
 *
 * `setPublishedAppTier` reads FOR UPDATE inside a transaction and then writes
 * guarded on the tier it planned against, so the double has to carry `.for()` on
 * the select chain and `.returning()` on the update chain.
 */
const mockDb = vi.hoisted(() => {
  const state: {
    rows: unknown[];
    updateSets: Array<Record<string, unknown>>;
    /** Rows the guarded UPDATE ... RETURNING gives back, in order. */
    returning: unknown[][];
    inserted: Array<Record<string, unknown>>;
  } = { rows: [], updateSets: [], returning: [], inserted: [] };

  // Three shapes are used against this double: `.where(...)` awaited directly
  // (the dunning survey), `.where(...).limit(1)` awaited, and
  // `.where(...).limit(1).for('update')`. So both `where` and `limit` return a
  // thenable that also carries the next link in the chain.
  const select = () => ({
    from: () => ({
      where: () => ({
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(state.rows).then(resolve),
        limit: () => ({
          then: (r: (v: unknown) => unknown) => Promise.resolve(state.rows).then(r),
          for: async () => state.rows,
        }),
      }),
    }),
  });

  const update = () => ({
    set: (payload: Record<string, unknown>) => {
      state.updateSets.push(payload);
      return { where: () => ({ returning: async () => state.returning.shift() ?? [] }) };
    },
  });

  const insert = () => ({
    values: (payload: Record<string, unknown>) => {
      state.inserted.push(payload);
      return { onConflictDoUpdate: () => ({ returning: async () => [payload] }) };
    },
  });

  return {
    __state: state,
    select,
    update,
    insert,
    // The mirror write upserts INSIDE the transaction (it reads FOR UPDATE first),
    // so the tx double has to carry `insert` too.
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({ select, update, insert }),
  };
});
vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
// Full factory mocks (no `importOriginal`) so this suite runs against SOURCE and
// needs no built @pagespace/db: the module under test uses the operators only to
// build opaque predicate objects the db double ignores, and the table objects only
// as identity handles.
vi.mock('@pagespace/db/operators', () => ({
  and: (...a: unknown[]) => ({ op: 'and', a }),
  eq: (a: unknown, b: unknown) => ({ op: 'eq', a, b }),
}));
vi.mock('@pagespace/db/schema/published-apps', () => ({ publishedApps: { id: 'published_apps.id', tier: 'published_apps.tier' } }));
vi.mock('@pagespace/db/schema/published-app-subscriptions', () => ({
  publishedAppSubscriptions: { publishedAppId: 'pas.publishedAppId', stripeSubscriptionId: 'pas.stripeSubscriptionId' },
}));

const mockIsEnabled = vi.hoisted(() => vi.fn(() => true));
const mockIsBillingEnabled = vi.hoisted(() => vi.fn(() => true));
vi.mock('../app-hosting-env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isAppHostingEnabled: mockIsEnabled,
  resolveFlyMachinesToken: () => 'token',
}));
vi.mock('../../../deployment-mode', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isBillingEnabled: mockIsBillingEnabled,
}));
// The real credit-consume reaches for `@pagespace/db/schema/credits` at module
// load. Only the DEFAULT deps binding uses it, and every test here injects its
// own `releaseHold`, so the module is stubbed to keep this suite runnable against
// source with no built @pagespace/db.
vi.mock('../../../billing/credit-consume', () => ({ releaseHold: vi.fn(async () => undefined) }));
vi.mock('../../../logging/logger-config', () => ({
  loggers: { ai: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
}));

import {
  DEDICATED_DUNNING_VISIBILITY_DAYS,
  isDedicatedTierPurchasable,
  recordDedicatedSubscription,
  setPublishedAppTier,
  surveyDedicatedDunning,
  syncAppTierToSubscription,
  type DedicatedTierDeps,
} from '../dedicated-tier-service';

const APP = {
  id: 'app_1',
  driveId: 'drive_1',
  flyAppName: 'pgs-app-app_1',
  machineId: 'm_1',
  status: 'running',
  tier: 'metered',
  guestPreset: 'shared-cpu-1x-512',
  lastError: null,
};

function deps(overrides: Partial<DedicatedTierDeps> = {}): DedicatedTierDeps {
  return {
    isEnabled: () => true,
    updateMachineConfig: vi.fn(async () => undefined),
    releaseHold: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.__state.rows = [];
  mockDb.__state.updateSets.length = 0;
  mockDb.__state.returning.length = 0;
  mockDb.__state.inserted.length = 0;
  mockIsEnabled.mockReturnValue(true);
  mockIsBillingEnabled.mockReturnValue(true);
});

describe('isDedicatedTierPurchasable', () => {
  it('is false where billing is disabled, so no Stripe call is ever attempted', () => {
    // Tenant and onprem: hosting is unlimited by design and there is no customer
    // to charge, so "buy always-on" cannot happen — and the honest shape of that
    // is a flag that refuses, not a Stripe call that errors.
    mockIsBillingEnabled.mockReturnValue(false);
    assert({
      given: 'a deployment with billing disabled',
      should: 'not offer the dedicated tier for sale',
      actual: isDedicatedTierPurchasable(),
      expected: false,
    });
  });

  it('is false while hosting is dark', () => {
    mockIsEnabled.mockReturnValue(false);
    assert({
      given: 'APP_HOSTING_ENABLED unset',
      should: 'not offer the dedicated tier for sale',
      actual: isDedicatedTierPurchasable(),
      expected: false,
    });
  });

  it('is true on a billing-enabled deployment with hosting on', () => {
    assert({
      given: 'cloud with hosting enabled',
      should: 'offer the dedicated tier',
      actual: isDedicatedTierPurchasable(),
      expected: true,
    });
  });
});

describe('setPublishedAppTier', () => {
  it('un-parks in the SAME statement as the tier write', async () => {
    // `published_apps_parked_is_metered_only` makes a parked dedicated row
    // unrepresentable, so "set the tier, then fix the status" is two statements of
    // which the first cannot commit.
    mockDb.__state.rows = [{ ...APP, status: 'parked', lastError: 'parked: insufficient_credits' }];
    mockDb.__state.returning = [[{ ...APP, status: 'stopped', tier: 'dedicated' }]];

    const result = await setPublishedAppTier('app_1', 'dedicated', deps());

    expect(result.ok).toBe(true);
    assert({
      given: 'an upgrade of a parked app',
      should: 'write the tier, the un-parked status and the cleared reason together',
      actual: mockDb.__state.updateSets[0],
      // The window columns are nulled on every upgrade — already null here, and
      // the write is the same one that closes a LIVE app's window (below).
      expected: {
        tier: 'dedicated',
        status: 'stopped',
        lastError: null,
        awakeBilledThrough: null,
        awakeHoldId: null,
      },
    });
  });

  it('clears the park reason so the publish surface stops blaming credits', async () => {
    mockDb.__state.rows = [{ ...APP, status: 'parked', lastError: 'parked: insufficient_credits' }];
    mockDb.__state.returning = [[{ ...APP, status: 'stopped', tier: 'dedicated' }]];
    await setPublishedAppTier('app_1', 'dedicated', deps());
    assert({
      given: 'an app that just paid for always-on',
      should: 'no longer carry an out-of-credits reason',
      actual: mockDb.__state.updateSets[0].lastError,
      expected: null,
    });
  });

  it('leaves a running app running', async () => {
    mockDb.__state.rows = [{ ...APP, status: 'running' }];
    mockDb.__state.returning = [[{ ...APP, tier: 'dedicated' }]];
    await setPublishedAppTier('app_1', 'dedicated', deps());
    assert({
      given: 'an upgrade of a live app',
      should: 'change the tier and leave the status alone',
      actual: mockDb.__state.updateSets[0],
      expected: {
        tier: 'dedicated',
        status: 'running',
        awakeBilledThrough: null,
        awakeHoldId: null,
      },
    });
  });

  it('pushes min_machines_running to the live machine through the merge path', async () => {
    mockDb.__state.rows = [{ ...APP }];
    mockDb.__state.returning = [[{ ...APP, tier: 'dedicated' }]];
    const updateMachineConfig = vi.fn(async (_app: string, _machine: string, merge: (c: never) => unknown) => {
      // Prove the callback is a MERGE over the live config, not a fresh object:
      // a partial post would delete the app's services with a 200 OK.
      const merged = merge({ image: 'img', services: [{ internal_port: 8080 }] } as never) as {
        image: string;
        services: Array<Record<string, unknown>>;
      };
      expect(merged.image, 'the live image must survive the merge').toBe('img');
      expect(merged.services[0].min_machines_running).toBe(1);
    });

    const result = await setPublishedAppTier('app_1', 'dedicated', deps({ updateMachineConfig }));

    expect(updateMachineConfig).toHaveBeenCalledWith('pgs-app-app_1', 'm_1', expect.any(Function));
    assert({
      given: 'a successful push',
      should: 'report the machine as synced',
      actual: result.ok === true ? result.machineConfigSynced : null,
      expected: true,
    });
  });

  it('keeps the paid-for tier when Fly is unreachable', async () => {
    // Rolling the tier back because Fly was briefly down would undo a paid upgrade
    // over a transient network error. The row is the source of truth; the machine
    // config is a projection the next deploy re-derives anyway.
    mockDb.__state.rows = [{ ...APP }];
    mockDb.__state.returning = [[{ ...APP, tier: 'dedicated' }]];
    const result = await setPublishedAppTier(
      'app_1',
      'dedicated',
      deps({ updateMachineConfig: vi.fn(async () => { throw new Error('flaps 503'); }) }),
    );
    assert({
      given: 'a tier change whose machine push failed',
      should: 'still be a successful tier change',
      actual: result.ok,
      expected: true,
    });
    assert({
      given: 'a failed push',
      should: 'report the machine as unsynced so it can be repaired',
      actual: result.ok === true ? [result.machineConfigSynced, result.machineConfigError] : null,
      expected: [false, 'flaps 503'],
    });
  });

  it('does not call Fly for an app with no machine yet', async () => {
    mockDb.__state.rows = [{ ...APP, machineId: null, status: 'building' }];
    mockDb.__state.returning = [[{ ...APP, machineId: null, status: 'building', tier: 'dedicated' }]];
    const updateMachineConfig = vi.fn();
    const result = await setPublishedAppTier('app_1', 'dedicated', deps({ updateMachineConfig }));
    expect(updateMachineConfig).not.toHaveBeenCalled();
    assert({
      given: 'an app that has never deployed',
      should: 'report synced — the next deploy builds the config from the tier',
      actual: result.ok === true ? result.machineConfigSynced : null,
      expected: true,
    });
  });


  it('closes the awake window and RETURNS the hold when upgrading a live app', async () => {
    // The moment the tier changes, the awake meter stops listing this row — so
    // nothing would ever settle the open window or release the wake's hold, and
    // the reservation would suppress the payer's spendable balance for its whole
    // TTL against a charge that is never coming.
    mockDb.__state.rows = [{ ...APP, status: 'running', awakeBilledThrough: new Date(), awakeHoldId: 'hold-live' }];
    mockDb.__state.returning = [[{ ...APP, tier: 'dedicated' }]];
    const releaseHold = vi.fn(async () => undefined);

    await setPublishedAppTier('app_1', 'dedicated', deps({ releaseHold }));

    assert({
      given: 'an upgrade of an app that is awake and being metered',
      should: 'close the billing window in the same statement as the tier',
      actual: mockDb.__state.updateSets[0],
      expected: {
        tier: 'dedicated',
        status: 'running',
        awakeBilledThrough: null,
        awakeHoldId: null,
      },
    });
    expect(releaseHold, 'the wake’s reservation must be returned').toHaveBeenCalledWith('hold-live');
  });

  it('does not close a window when DOWNgrading — the meter reopens one itself', async () => {
    // A metered row with no watermark is exactly the case the awake meter's
    // "no window" branch handles: it stamps at NOW, bills nothing for the unknown
    // span, and places a fresh hold.
    mockDb.__state.rows = [{ ...APP, tier: 'dedicated', status: 'running', awakeBilledThrough: null, awakeHoldId: null }];
    mockDb.__state.returning = [[{ ...APP, tier: 'metered' }]];
    const releaseHold = vi.fn(async () => undefined);

    await setPublishedAppTier('app_1', 'metered', deps({ releaseHold }));

    assert({
      given: 'a downgrade',
      should: 'touch only the tier and status',
      actual: mockDb.__state.updateSets[0],
      expected: { tier: 'metered', status: 'running' },
    });
    expect(releaseHold).not.toHaveBeenCalled();
  });

  it('still reports a successful upgrade when the hold could not be returned', async () => {
    // The hold expires on its own TTL. Throwing here would report a COMMITTED
    // upgrade as a failure and invite a retry that finds `same_tier`.
    mockDb.__state.rows = [{ ...APP, status: 'running', awakeBilledThrough: new Date(), awakeHoldId: 'hold-live' }];
    mockDb.__state.returning = [[{ ...APP, tier: 'dedicated' }]];
    const result = await setPublishedAppTier(
      'app_1',
      'dedicated',
      deps({ releaseHold: vi.fn(async () => { throw new Error('ledger down'); }) }),
    );
    assert({
      given: 'a committed upgrade whose hold release failed',
      should: 'still be a successful tier change',
      actual: result.ok,
      expected: true,
    });
  });

  it('refuses a downgrade that would strand the app on an unmeterable guest', async () => {
    mockDb.__state.rows = [{ ...APP, tier: 'dedicated', guestPreset: 'shared-cpu-4x-4096' }];
    const result = await setPublishedAppTier('app_1', 'metered', deps());
    assert({
      given: 'a big dedicated app being downgraded',
      should: 'refuse rather than silently resize a serving machine',
      actual: result,
      expected: { ok: false, reason: 'guest_preset_not_allowed' },
    });
    assert({
      given: 'a refused tier change',
      should: 'write nothing',
      actual: mockDb.__state.updateSets,
      expected: [],
    });
  });

  it('is inert while hosting is dark', async () => {
    const result = await setPublishedAppTier('app_1', 'dedicated', deps({ isEnabled: () => false }));
    assert({
      given: 'a disabled deployment',
      should: 'refuse without reading anything',
      actual: result,
      expected: { ok: false, reason: 'disabled' },
    });
  });
});

describe('syncAppTierToSubscription', () => {
  it('acks a subscription nothing local points at', async () => {
    // Stripe redelivers forever against a row that is never going to appear (a
    // subscription created against another environment's database, the common
    // test-mode case), so this must be an ack rather than a throw.
    const outcome = await syncAppTierToSubscription(null);
    assert({
      given: 'no mirror row for the event',
      should: 'report it rather than throw',
      actual: outcome,
      expected: { outcome: 'unknown_subscription' },
    });
  });

  it('takes the tier from the MIRROR, never from an event we refused', async () => {
    // The guard would be worse than useless if the write could be refused and the
    // tier move anyway: it would look defended and not be.
    mockDb.__state.rows = [{ ...APP, tier: 'dedicated', status: 'running' }];
    mockDb.__state.returning = [[{ ...APP, tier: 'metered' }]];

    const outcome = await syncAppTierToSubscription({ publishedAppId: 'app_1', status: 'canceled' });

    assert({
      given: 'a mirror row that says canceled',
      should: 'downgrade the app, whatever any event claimed',
      actual: outcome,
      expected: { outcome: 'downgraded', publishedAppId: 'app_1', tierChanged: true },
    });
    assert({
      given: 'the downgrade',
      should: 'write the metered tier',
      actual: mockDb.__state.updateSets[0].tier,
      expected: 'metered',
    });
  });
});

describe('surveyDedicatedDunning', () => {
  const NOW = new Date('2026-08-25T00:00:00.000Z');
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

  it('counts only the apps overdue past the visibility threshold', () => {
    // The bound on the past_due free ride is a STRIPE ACCOUNT SETTING, not code.
    // This counter is the only thing that would ever notice an account configured
    // to leave failed subscriptions past_due forever.
    mockDb.__state.rows = [
      { publishedAppId: 'fresh', currentPeriodEnd: daysAgo(1) },
      { publishedAppId: 'also_fresh', currentPeriodEnd: daysAgo(DEDICATED_DUNNING_VISIBILITY_DAYS - 1) },
      { publishedAppId: 'stale', currentPeriodEnd: daysAgo(DEDICATED_DUNNING_VISIBILITY_DAYS + 1) },
      { publishedAppId: 'very_stale', currentPeriodEnd: daysAgo(90) },
    ];
    return surveyDedicatedDunning(NOW).then((survey) => {
      assert({
        given: 'four past_due dedicated apps, two of them long overdue',
        should: 'report every past_due app and name only the long-overdue ones',
        actual: survey,
        expected: { pastDue: 4, pastDueStale: 2, staleAppIds: ['stale', 'very_stale'] },
      });
    });
  });

  it('does not count a subscription still inside a normal retry window', async () => {
    // A card that is going to work has worked well before the threshold, so a row
    // under it means dunning is still in progress rather than not converging.
    mockDb.__state.rows = [{ publishedAppId: 'retrying', currentPeriodEnd: daysAgo(2) }];
    const survey = await surveyDedicatedDunning(NOW);
    assert({
      given: 'a subscription two days overdue',
      should: 'be counted as past_due but not as stale',
      actual: [survey.pastDue, survey.pastDueStale],
      expected: [1, 0],
    });
  });

  it('reports nothing while hosting is dark', async () => {
    mockIsEnabled.mockReturnValue(false);
    mockDb.__state.rows = [{ publishedAppId: 'stale', currentPeriodEnd: daysAgo(90) }];
    assert({
      given: 'a deployment with hosting switched off',
      should: 'read nothing and report zeroes',
      actual: await surveyDedicatedDunning(NOW),
      expected: { pastDue: 0, pastDueStale: 0, staleAppIds: [] },
    });
  });
});

describe('recordDedicatedSubscription', () => {
  const facts = (over: Record<string, unknown> = {}) => ({
    publishedAppId: 'app_1',
    userId: 'user_1',
    stripeSubscriptionId: 'sub_1',
    stripePriceId: 'price_1',
    guestPreset: 'shared-cpu-1x-512',
    status: 'active',
    currentPeriodStart: new Date('2026-08-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-09-01T00:00:00Z'),
    cancelAtPeriodEnd: false,
    stripeEventCreated: new Date('2026-08-25T12:00:00Z'),
    ...over,
  });

  const stored = (over: Record<string, unknown> = {}) => ({
    id: 'pas_1',
    publishedAppId: 'app_1',
    userId: 'user_1',
    stripeSubscriptionId: 'sub_1',
    stripePriceId: 'price_1',
    guestPreset: 'shared-cpu-1x-512',
    status: 'canceled',
    stripeEventCreated: new Date('2026-08-25T12:00:00Z'),
    ...over,
  });

  it('writes the row and stamps the event it came from', async () => {
    mockDb.__state.rows = [];
    const result = await recordDedicatedSubscription(facts());
    assert({
      given: 'a first write',
      should: 'apply',
      actual: result.outcome,
      expected: 'applied',
    });
    assert({
      given: 'the applied write',
      should: 'carry the ordering stamp',
      actual: mockDb.__state.inserted[0].stripeEventCreated,
      expected: new Date('2026-08-25T12:00:00Z'),
    });
  });

  it('REFUSES a late event for a subscription that has already ended, and writes nothing', async () => {
    // The permanent re-entitlement: applied, this would leave an always-on app
    // with no paying subscription and no further event coming to correct it.
    mockDb.__state.rows = [stored({ status: 'canceled' })];
    const result = await recordDedicatedSubscription(
      facts({ status: 'active', stripeEventCreated: new Date('2026-08-25T13:00:00Z') }),
    );
    assert({
      given: 'a late active event against a canceled row',
      should: 'be absorbed',
      actual: result.outcome,
      expected: 'terminal_absorbed',
    });
    assert({
      given: 'an absorbed event',
      should: 'write nothing at all',
      actual: mockDb.__state.inserted,
      expected: [],
    });
  });

  it('hands the STORED row back on a refusal, so the tier follows what we believe', async () => {
    // Returning nothing here would leave the caller with only the event it was
    // just told to disbelieve.
    mockDb.__state.rows = [stored({ status: 'canceled' })];
    const result = await recordDedicatedSubscription(facts({ status: 'active' }));
    assert({
      given: 'a refused write',
      should: 'return the row the mirror still holds',
      actual: result.row?.status,
      expected: 'canceled',
    });
  });

  it('refuses an event older than the one already applied', async () => {
    mockDb.__state.rows = [stored({ status: 'active' })];
    const result = await recordDedicatedSubscription(
      facts({ status: 'past_due', stripeEventCreated: new Date('2026-08-25T11:00:00Z') }),
    );
    assert({
      given: 'a stale event',
      should: 'be refused',
      actual: [result.outcome, mockDb.__state.inserted.length],
      expected: ['stale_event', 0],
    });
  });

  it('lets a NEW subscription write over a terminal row', async () => {
    mockDb.__state.rows = [stored({ status: 'canceled' })];
    const result = await recordDedicatedSubscription(
      facts({ stripeSubscriptionId: 'sub_2', stripeEventCreated: new Date('2026-08-25T13:00:00Z') }),
    );
    assert({
      given: 'a re-buy',
      should: 'apply — a new subscription id is the re-entitlement path',
      actual: result.outcome,
      expected: 'applied',
    });
  });

  it('is inert while hosting is dark', async () => {
    mockIsEnabled.mockReturnValue(false);
    const result = await recordDedicatedSubscription(facts());
    assert({
      given: 'a disabled deployment',
      should: 'write nothing',
      actual: [result.row, mockDb.__state.inserted.length],
      expected: [null, 0],
    });
  });
});
