/**
 * router — the imperative shell, tested through injected deps.
 *
 * The pure decision is covered in `router-core.test.ts`. What this file asserts
 * is what the SHELL adds, and each of those is a place the enforcement property
 * could be lost without the pure test noticing:
 *
 *   • the kill switch short-circuits BEFORE any database read;
 *   • the balance is asked about the app's DRIVE-OWNER payer, resolved the SAME
 *     way the awake-seconds meter resolves it — never `published_apps.ownerId`;
 *   • the ledger is not consulted at all for a dedicated app;
 *   • a STOPPED app is woken through the real wake seam (gate + hold + start +
 *     bookkeeping) rather than replayed to and left for Fly's silent autostart;
 *   • a router that cannot derive a replay key refuses rather than emitting a
 *     replay with a blank state;
 *   • a real failure (database down) propagates instead of reading as a miss.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({ db: { select: vi.fn() } }));
vi.mock('@pagespace/db/schema/published-apps', () => ({
  publishedApps: {
    id: 'id',
    flyAppName: 'flyAppName',
    status: 'status',
    tier: 'tier',
    machineId: 'machineId',
    driveId: 'driveId',
    subdomain: 'subdomain',
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: (a: unknown, b: unknown) => ({ eq: [a, b] }) }));
// The billing modules are mocked rather than imported: every balance read in this
// file goes through an injected dep, so pulling in the real credit gate would drag
// the whole ledger schema into a suite that never calls it. Their own semantics are
// covered in `billing/__tests__/credit-gate.test.ts`.
vi.mock('../../../billing/credit-gate', () => ({ hasSpendableBalance: vi.fn() }));
vi.mock('../../../billing/credit-balance', () => ({ resolveTier: vi.fn() }));
// Same reasoning: `app-billing`'s default payer resolver drags in the whole
// credit/monitoring stack to build, and `app-lifecycle-metering`'s wake seam
// drags in Fly clients and the provisioner. Both are asserted BEHAVIOURALLY
// (does the router's default binding delegate to them with the right args),
// which needs a mock, not the real module.
vi.mock('../app-billing', () => ({ defaultAppBillingDeps: { resolvePayerId: vi.fn() } }));
vi.mock('../app-lifecycle-metering', () => ({
  wakePublishedApp: vi.fn(),
  defaultAppLifecycleMeteringDeps: { __marker: 'default-lifecycle-deps' },
}));

import {
  defaultAppRouterDeps,
  resolveAppRoute,
  type AppRouterDeps,
  type PublishedAppRouteRow,
} from '../router';
import { db } from '@pagespace/db/db';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { hasSpendableBalance } from '../../../billing/credit-gate';
import { resolveTier } from '../../../billing/credit-balance';
import { defaultAppBillingDeps } from '../app-billing';
import { wakePublishedApp, defaultAppLifecycleMeteringDeps, type WakePublishedAppResult } from '../app-lifecycle-metering';
import { isAppHostingEnabled } from '../app-hosting-env';
import { resolveAppReplaySecret, resolvePublishedAppsApex } from '../routing-env';

const SECRET = 'a'.repeat(48);

function row(overrides: Partial<PublishedAppRouteRow> = {}): PublishedAppRouteRow {
  return {
    id: 'app_1',
    flyAppName: 'pgs-app-abc123',
    status: 'running',
    tier: 'metered',
    machineId: 'm-1',
    driveId: 'drive_payer',
    ...overrides,
  };
}

function deps(overrides: Partial<AppRouterDeps> = {}): AppRouterDeps {
  return {
    isEnabled: () => true,
    apex: () => 'pagespace.app',
    replaySecret: () => SECRET,
    findAppBySubdomain: async () => row(),
    resolvePayerId: async ({ driveId }) => (driveId === 'drive_payer' ? 'user_payer' : null),
    resolveTier: async () => 'pro',
    hasSpendableBalance: async () => true,
    wakePublishedApp: async () =>
      ({ outcome: 'woken', app: {} }) as unknown as WakePublishedAppResult,
    ...overrides,
  };
}

describe('resolveAppRoute — the kill switch is checked before the database', () => {
  it('given hosting is disabled, should answer hosting_disabled without any lookup', async () => {
    const findAppBySubdomain = vi.fn();
    const decision = await resolveAppRoute(
      'acme.pagespace.app',
      deps({ isEnabled: () => false, findAppBySubdomain }),
    );
    expect(decision).toEqual({ kind: 'unavailable', reason: 'hosting_disabled' });
    expect(findAppBySubdomain).not.toHaveBeenCalled();
  });
});

describe('resolveAppRoute — hostname resolution', () => {
  it('given the apex itself, should answer not_found without a lookup', async () => {
    const findAppBySubdomain = vi.fn();
    const decision = await resolveAppRoute('pagespace.app', deps({ findAppBySubdomain }));
    expect(decision).toEqual({ kind: 'not_found', reason: 'apex' });
    expect(findAppBySubdomain).not.toHaveBeenCalled();
  });

  it('given a custom domain, should answer custom_host so the proxy keeps serving it', async () => {
    const findAppBySubdomain = vi.fn();
    const decision = await resolveAppRoute('docs.acme.com', deps({ findAppBySubdomain }));
    expect(decision).toEqual({ kind: 'not_found', reason: 'custom_host' });
    expect(findAppBySubdomain).not.toHaveBeenCalled();
  });

  it('given a subdomain with no row, should answer no_such_app', async () => {
    const decision = await resolveAppRoute(
      'nobody.pagespace.app',
      deps({ findAppBySubdomain: async () => null }),
    );
    expect(decision).toEqual({ kind: 'not_found', reason: 'no_such_app' });
  });

  it('given a host with a port, should look up the normalized label', async () => {
    const findAppBySubdomain = vi.fn(async () => row());
    await resolveAppRoute('ACME.pagespace.app:443', deps({ findAppBySubdomain }));
    expect(findAppBySubdomain).toHaveBeenCalledWith('acme');
  });
});

describe('resolveAppRoute — the balance is asked about the SAME payer the meter charges', () => {
  it("given a metered app, should resolve the payer from the row's driveId, not published_apps.ownerId", async () => {
    const resolvePayerId = vi.fn(async ({ driveId }: { driveId: string }) =>
      driveId === 'drive_xyz' ? 'user_drive_owner' : null,
    );
    const hasSpendableBalance = vi.fn(async () => true);
    const resolveTier = vi.fn(async () => 'pro');
    await resolveAppRoute(
      'acme.pagespace.app',
      deps({
        findAppBySubdomain: async () => row({ driveId: 'drive_xyz' }),
        resolvePayerId,
        resolveTier,
        hasSpendableBalance,
      }),
    );
    expect(resolvePayerId).toHaveBeenCalledWith({ driveId: 'drive_xyz' });
    expect(resolveTier).toHaveBeenCalledWith('user_drive_owner');
    expect(hasSpendableBalance).toHaveBeenCalledWith('user_drive_owner', 'pro');
  });

  it('given an unresolvable drive, should refuse (fail closed) rather than serve on an unverified balance', async () => {
    const resolveTier = vi.fn(async () => 'pro');
    const hasSpendableBalance = vi.fn(async () => true);
    const decision = await resolveAppRoute(
      'acme.pagespace.app',
      deps({ resolvePayerId: async () => null, resolveTier, hasSpendableBalance }),
    );
    expect(decision).toEqual({ kind: 'parked', reason: 'out_of_credits' });
    expect(resolveTier).not.toHaveBeenCalled();
    expect(hasSpendableBalance).not.toHaveBeenCalled();
  });

  it('given an insolvent payer, should park rather than replay', async () => {
    const decision = await resolveAppRoute(
      'acme.pagespace.app',
      deps({ hasSpendableBalance: async () => false }),
    );
    expect(decision).toEqual({ kind: 'parked', reason: 'out_of_credits' });
  });

  it('given a DEDICATED app, should never touch the ledger at all', async () => {
    const hasSpendableBalance = vi.fn(async () => false);
    const resolveTier = vi.fn(async () => 'pro');
    const decision = await resolveAppRoute(
      'acme.pagespace.app',
      deps({
        findAppBySubdomain: async () => row({ tier: 'dedicated' }),
        resolveTier,
        hasSpendableBalance,
      }),
    );
    expect(decision.kind).toBe('replay');
    expect(resolveTier).not.toHaveBeenCalled();
    expect(hasSpendableBalance).not.toHaveBeenCalled();
  });

  it('given an app that is not servable anyway, should skip the balance read', async () => {
    const hasSpendableBalance = vi.fn(async () => true);
    const decision = await resolveAppRoute(
      'acme.pagespace.app',
      deps({ findAppBySubdomain: async () => row({ status: 'parked' }), hasSpendableBalance }),
    );
    expect(decision).toEqual({ kind: 'parked', reason: 'parked_status' });
    expect(hasSpendableBalance).not.toHaveBeenCalled();
  });
});

describe('resolveAppRoute — a STOPPED app is woken through the real seam, never autostarted blind', () => {
  it('given a running app, should never call the wake seam at all', async () => {
    const wakePublishedApp = vi.fn();
    await resolveAppRoute('acme.pagespace.app', deps({ findAppBySubdomain: async () => row({ status: 'running' }), wakePublishedApp }));
    expect(wakePublishedApp).not.toHaveBeenCalled();
  });

  it('given a stopped app that wakes cleanly, should decide as if it were running — a replay', async () => {
    const wakePublishedApp = vi.fn(async () => ({ outcome: 'woken', app: {} }) as unknown as WakePublishedAppResult);
    const decision = await resolveAppRoute(
      'acme.pagespace.app',
      deps({ findAppBySubdomain: async () => row({ status: 'stopped' }), wakePublishedApp }),
    );
    expect(wakePublishedApp).toHaveBeenCalledWith('app_1');
    expect(decision.kind).toBe('replay');
  });

  it('given the wake gate refuses (insolvent), should park rather than replay', async () => {
    const wakePublishedApp = vi.fn(
      async () => ({ outcome: 'parked', reason: 'insufficient_credits' }) as unknown as WakePublishedAppResult,
    );
    const decision = await resolveAppRoute(
      'acme.pagespace.app',
      deps({ findAppBySubdomain: async () => row({ status: 'stopped' }), wakePublishedApp }),
    );
    expect(decision).toEqual({ kind: 'parked', reason: 'out_of_credits' });
  });

  it('given Fly refuses the start, should answer unavailable rather than replay to a machine that never came up', async () => {
    const wakePublishedApp = vi.fn(
      async () => ({ outcome: 'start_failed', error: 'capacity' }) as unknown as WakePublishedAppResult,
    );
    const decision = await resolveAppRoute(
      'acme.pagespace.app',
      deps({ findAppBySubdomain: async () => row({ status: 'stopped' }), wakePublishedApp }),
    );
    expect(decision).toEqual({ kind: 'unavailable', reason: 'failed' });
  });

  it('given the wake refuses because hosting flipped off mid-request, should answer hosting_disabled', async () => {
    const wakePublishedApp = vi.fn(
      async () => ({ outcome: 'refused', reason: 'disabled' }) as unknown as WakePublishedAppResult,
    );
    const decision = await resolveAppRoute(
      'acme.pagespace.app',
      deps({ findAppBySubdomain: async () => row({ status: 'stopped' }), wakePublishedApp }),
    );
    expect(decision).toEqual({ kind: 'unavailable', reason: 'hosting_disabled' });
  });

  it('given any other wake refusal, should answer unavailable rather than replay to an un-woken app', async () => {
    const wakePublishedApp = vi.fn(
      async () => ({ outcome: 'refused', reason: 'no_machine' }) as unknown as WakePublishedAppResult,
    );
    const decision = await resolveAppRoute(
      'acme.pagespace.app',
      deps({ findAppBySubdomain: async () => row({ status: 'stopped' }), wakePublishedApp }),
    );
    expect(decision).toEqual({ kind: 'unavailable', reason: 'failed' });
  });
});

describe('resolveAppRoute — the replay key must exist before traffic is replayed', () => {
  it('given a solvent servable app, should emit a replay carrying a derived state key', async () => {
    const decision = await resolveAppRoute('acme.pagespace.app', deps());
    expect(decision.kind).toBe('replay');
    if (decision.kind !== 'replay') throw new Error('expected a replay');
    expect(decision.flyAppName).toBe('pgs-app-abc123');
    // Derived, hex, and not the placeholder the provisional decision carries.
    expect(decision.state).toMatch(/^[0-9a-f]{64}$/);
    expect(decision.state).not.toBe('pending');
  });

  it('given an UNSET replay secret, should refuse rather than replay with a blank state', async () => {
    const decision = await resolveAppRoute('acme.pagespace.app', deps({ replaySecret: () => '' }));
    expect(decision).toEqual({ kind: 'unavailable', reason: 'failed' });
  });

  it('given a too-short replay secret, should refuse', async () => {
    const decision = await resolveAppRoute(
      'acme.pagespace.app',
      deps({ replaySecret: () => 'short' }),
    );
    expect(decision).toEqual({ kind: 'unavailable', reason: 'failed' });
  });

  it('given two different apps, should derive different state keys', async () => {
    const a = await resolveAppRoute(
      'a.pagespace.app',
      deps({ findAppBySubdomain: async () => row({ flyAppName: 'pgs-app-aaa' }) }),
    );
    const b = await resolveAppRoute(
      'b.pagespace.app',
      deps({ findAppBySubdomain: async () => row({ flyAppName: 'pgs-app-bbb' }) }),
    );
    if (a.kind !== 'replay' || b.kind !== 'replay') throw new Error('expected replays');
    expect(a.state).not.toBe(b.state);
  });
});

describe('resolveAppRoute — an outage is not a miss', () => {
  it('given the lookup throws, should propagate so the caller can answer 503', async () => {
    await expect(
      resolveAppRoute(
        'acme.pagespace.app',
        deps({
          findAppBySubdomain: async () => {
            throw new Error('connection terminated');
          },
        }),
      ),
    ).rejects.toThrow('connection terminated');
  });

  it('given the balance read throws, should propagate rather than park the app', async () => {
    await expect(
      resolveAppRoute(
        'acme.pagespace.app',
        deps({
          hasSpendableBalance: async () => {
            throw new Error('ledger unavailable');
          },
        }),
      ),
    ).rejects.toThrow('ledger unavailable');
  });
});


/**
 * The composition root.
 *
 * Every other test in this file injects its own deps, and the route test mocks
 * this module wholesale — so `defaultAppRouterDeps`, the object that decides what
 * ACTUALLY runs at the serving edge, was asserted by nothing. That is a worse gap
 * than it sounds: a mistake here is invisible to every mutation check on the
 * decision function, because the decision function is not what is wrong.
 *
 * Bind `hasSpendableBalance` to `getCreditBalance` instead of the read-only twin
 * and the per-request `SUM` over `credit_holds` comes back — every test still
 * passes. Point `isEnabled` at anything truthy and hosting serves while the flag
 * says dark — every test still passes. So the wiring is asserted directly.
 */
describe('defaultAppRouterDeps — the real edge is wired to the real readers', () => {
  it('binds the kill switch, the apex and the replay secret by identity', () => {
    expect(defaultAppRouterDeps.isEnabled).toBe(isAppHostingEnabled);
    expect(defaultAppRouterDeps.apex).toBe(resolvePublishedAppsApex);
    expect(defaultAppRouterDeps.replaySecret).toBe(resolveAppReplaySecret);
  });

  // `resolveTier` and `hasSpendableBalance` are wrapped in arrows for the tier
  // cast, so identity cannot be asserted for them — and unwrapping them just to
  // make `toBe` work would delete the thing being checked. Asserted behaviourally
  // instead: the wrapper must delegate to the real module, with its own arguments.
  it('delegates the balance read to the read-only twin, with the arguments it was given', async () => {
    vi.mocked(hasSpendableBalance).mockResolvedValue(true);

    const answer = await defaultAppRouterDeps.hasSpendableBalance('user_payer', 'metered');

    expect(hasSpendableBalance).toHaveBeenCalledWith('user_payer', 'metered');
    expect(answer).toBe(true);
  });

  it('delegates the tier lookup, and returns what it answers', async () => {
    vi.mocked(resolveTier).mockResolvedValue('pro');

    const tier = await defaultAppRouterDeps.resolveTier('user_payer');

    expect(resolveTier).toHaveBeenCalledWith('user_payer');
    expect(tier).toBe('pro');
  });

  // The identical function `app-billing.ts` hands the meter and the wake gate —
  // not an equivalent bound the same way, the same reference — so "the router
  // asks the wrong payer" is structurally impossible rather than a convention
  // that can drift.
  it('resolves the payer through the IDENTICAL function the meter and wake gate use', () => {
    expect(defaultAppRouterDeps.resolvePayerId).toBe(defaultAppBillingDeps.resolvePayerId);
  });

  // Behavioural, not identity: the default binding is an arrow closing over
  // `defaultAppLifecycleMeteringDeps`, so it must be shown to delegate with the
  // right deps rather than compared by reference.
  it('wakes a stopped app through the real wake seam, with the real lifecycle deps', async () => {
    vi.mocked(wakePublishedApp).mockResolvedValue({ outcome: 'woken', app: {} } as unknown as WakePublishedAppResult);

    const result = await defaultAppRouterDeps.wakePublishedApp('app_1');

    expect(wakePublishedApp).toHaveBeenCalledWith('app_1', defaultAppLifecycleMeteringDeps);
    expect(result).toEqual({ outcome: 'woken', app: {} });
  });

  // The row reader is module-private, so it is pinned by what it queries: the
  // published_apps table, keyed on `subdomain`, one row.
  it('reads the published_apps row for the subdomain it is asked about', async () => {
    const found = row();
    const limit = vi.fn().mockResolvedValue([found]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    vi.mocked(db.select).mockReturnValue({ from } as never);

    const result = await defaultAppRouterDeps.findAppBySubdomain('acme');

    expect(from).toHaveBeenCalledWith(publishedApps);
    expect(where).toHaveBeenCalledWith({ eq: [publishedApps.subdomain, 'acme'] });
    expect(limit).toHaveBeenCalledWith(1);
    expect(result).toEqual(found);
  });

  it('answers null when the subdomain matches no row, rather than undefined', async () => {
    const limit = vi.fn().mockResolvedValue([]);
    vi.mocked(db.select).mockReturnValue({ from: () => ({ where: () => ({ limit }) }) } as never);

    expect(await defaultAppRouterDeps.findAppBySubdomain('nope')).toBeNull();
  });
});
