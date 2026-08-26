/**
 * router — the imperative shell, tested through injected deps.
 *
 * The pure decision is covered in `router-core.test.ts`. What this file asserts
 * is what the SHELL adds, and each of those is a place the enforcement property
 * could be lost without the pure test noticing:
 *
 *   • the kill switch short-circuits BEFORE any database read;
 *   • the balance is asked about the row's OWN payer (`ownerId`), the same
 *     column the awake-seconds meter charges;
 *   • the ledger is not consulted at all for a dedicated app;
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
    ownerId: 'ownerId',
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
    ownerId: 'user_payer',
    ...overrides,
  };
}

function deps(overrides: Partial<AppRouterDeps> = {}): AppRouterDeps {
  return {
    isEnabled: () => true,
    apex: () => 'pagespace.app',
    replaySecret: () => SECRET,
    findAppBySubdomain: async () => row(),
    resolveTier: async () => 'pro',
    hasSpendableBalance: async () => true,
    stampHit: async () => {},
    wake: async () => ({ outcome: 'woken', app: {} as never }),
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

describe('resolveAppRoute — the balance is asked about the row own payer', () => {
  it("given a metered app, should ask about the row's ownerId, not any other user", async () => {
    const hasSpendableBalance = vi.fn(async () => true);
    const resolveTier = vi.fn(async () => 'pro');
    await resolveAppRoute(
      'acme.pagespace.app',
      deps({
        findAppBySubdomain: async () => row({ ownerId: 'user_drive_owner' }),
        resolveTier,
        hasSpendableBalance,
      }),
    );
    expect(resolveTier).toHaveBeenCalledWith('user_drive_owner');
    expect(hasSpendableBalance).toHaveBeenCalledWith('user_drive_owner', 'pro');
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


describe('resolveAppRoute — the last-hit stamp the idle reaper reads', () => {
  it('given a REPLAYED request, should stamp recency for the app it served', async () => {
    // Nothing else knows this happened: a replayed response goes straight from the
    // target app to the client and never passes back through us, and Fly's machine
    // events record starts and stops, not traffic. Without this stamp the reaper
    // has no evidence of demand and stops apps that are being used.
    const stampHit = vi.fn(async () => {});

    const decision = await resolveAppRoute('acme.pagespace.app', deps({ stampHit }));

    expect(decision.kind).toBe('replay');
    expect(stampHit).toHaveBeenCalledWith('app_1');
  });

  it('given a PARKED app, should stamp NOTHING — a refusal is not demand', async () => {
    // The regression this guards: stamping on refusal keeps a parked app looking
    // busy to the reaper forever, fed by exactly the crawler traffic that never
    // stops hitting a dead subdomain.
    const stampHit = vi.fn(async () => {});

    const decision = await resolveAppRoute(
      'acme.pagespace.app',
      deps({ stampHit, hasSpendableBalance: async () => false }),
    );

    expect(decision).toEqual({ kind: 'parked', reason: 'out_of_credits' });
    expect(stampHit).not.toHaveBeenCalled();
  });

  it('given an unknown host, should stamp nothing', async () => {
    const stampHit = vi.fn(async () => {});

    await resolveAppRoute('nobody.pagespace.app', deps({ stampHit, findAppBySubdomain: async () => null }));

    expect(stampHit).not.toHaveBeenCalled();
  });

  it('given the stamp FAILS, should still serve the app', async () => {
    // A bookkeeping write must never take a working app off the internet. The cost
    // of losing one stamp is that the app looks idle up to one throttle interval
    // early, and the next served request corrects it.
    const stampHit = vi.fn(async () => {
      throw new Error('write failed');
    });

    const decision = await resolveAppRoute('acme.pagespace.app', deps({ stampHit }));

    expect(decision.kind).toBe('replay');
  });
});


describe('resolveAppRoute — a STOPPED app is woken through the metering seam', () => {
  const stopped = (over: Record<string, unknown> = {}) => row({ status: 'stopped', ...over });

  it('given a stopped app, should WAKE it before replaying — a replay alone starts the machine unmetered', async () => {
    // THE LANDMINE THIS CLOSES: Fly's proxy auto-starts a stopped target the moment
    // a replay reaches it. A machine started that way opens an awake window nobody
    // recorded, on a row that still says `stopped` — so the heartbeat never bills it
    // (it lists `running` rows) and the reaper never stops it (so does it). The app
    // would run free from its first visit after any idle stop.
    const wake = vi.fn(async () => ({ outcome: 'woken' as const, app: {} as never }));

    const decision = await resolveAppRoute(
      'acme.pagespace.app',
      deps({ findAppBySubdomain: async () => stopped(), wake }),
    );

    expect(wake).toHaveBeenCalledWith('app_1');
    expect(decision.kind).toBe('replay');
  });

  it('given an already RUNNING app, should not wake anything — the hot path stays three reads', async () => {
    const wake = vi.fn(async () => ({ outcome: 'woken' as const, app: {} as never }));

    const decision = await resolveAppRoute('acme.pagespace.app', deps({ wake }));

    expect(decision.kind).toBe('replay');
    expect(wake).not.toHaveBeenCalled();
  });

  it('given Fly REFUSED the start, should answer unavailable rather than replay', async () => {
    // Replaying here would ask Fly's proxy to start the very machine we just
    // declined to bill for — the unmetered start, by another route.
    const stampHit = vi.fn(async () => {});

    const decision = await resolveAppRoute(
      'acme.pagespace.app',
      deps({
        findAppBySubdomain: async () => stopped(),
        wake: async () => ({ outcome: 'start_failed', error: 'fly said no' }),
        stampHit,
      }),
    );

    expect(decision).toEqual({ kind: 'unavailable', reason: 'failed' });
    expect(stampHit).not.toHaveBeenCalled();
  });

  it('given the wake GATE parked the app, should serve the parked page, told apart by reason', async () => {
    const outOfCredits = await resolveAppRoute(
      'acme.pagespace.app',
      deps({
        findAppBySubdomain: async () => stopped(),
        wake: async () => ({ outcome: 'parked', reason: 'insufficient_credits' }),
      }),
    );
    const dailyCap = await resolveAppRoute(
      'acme.pagespace.app',
      deps({
        findAppBySubdomain: async () => stopped(),
        wake: async () => ({ outcome: 'parked', reason: 'daily_awake_cap_exceeded' }),
      }),
    );

    expect({ outOfCredits, dailyCap }).toEqual({
      outOfCredits: { kind: 'parked', reason: 'out_of_credits' },
      // A different thing to be told: nobody needs to top anything up, and the app
      // returns by itself when the counter rolls over.
      dailyCap: { kind: 'parked', reason: 'daily_cap' },
    });
  });

  it.each([
    ['wake_in_progress', { outcome: 'wake_in_progress' as const }],
    ['not_wakeable', { outcome: 'refused' as const, reason: 'not_wakeable' as const }],
  ])('given %s — the cold-start burst — should REPLAY, because the machine is already starting', async (_name, wake) => {
    // A page asks for a document and then twenty assets, all within milliseconds and
    // all through this route. One request wins the wake; refusing the other twenty
    // would serve the unavailable page for every asset of a page that is coming up
    // perfectly well.
    const decision = await resolveAppRoute(
      'acme.pagespace.app',
      deps({ findAppBySubdomain: async () => stopped(), wake: async () => wake }),
    );

    expect(decision.kind).toBe('replay');
  });

  it('given the row vanished under the wake, should answer no_such_app', async () => {
    const decision = await resolveAppRoute(
      'acme.pagespace.app',
      deps({
        findAppBySubdomain: async () => stopped(),
        wake: async () => ({ outcome: 'refused', reason: 'not_found' }),
      }),
    );

    expect(decision).toEqual({ kind: 'not_found', reason: 'no_such_app' });
  });

  it('given an unresolvable payer, should refuse rather than start a machine nobody pays for', async () => {
    const decision = await resolveAppRoute(
      'acme.pagespace.app',
      deps({
        findAppBySubdomain: async () => stopped(),
        wake: async () => ({ outcome: 'refused', reason: 'unresolved_payer' }),
      }),
    );

    expect(decision).toEqual({ kind: 'unavailable', reason: 'failed' });
  });

  it('given an insolvent payer, should never reach the wake at all', async () => {
    // The router's own balance read refuses first, so a bankrupt app costs one
    // indexed read and never a Fly call.
    const wake = vi.fn(async () => ({ outcome: 'woken' as const, app: {} as never }));

    const decision = await resolveAppRoute(
      'acme.pagespace.app',
      deps({ findAppBySubdomain: async () => stopped(), hasSpendableBalance: async () => false, wake }),
    );

    expect(decision).toEqual({ kind: 'parked', reason: 'out_of_credits' });
    expect(wake).not.toHaveBeenCalled();
  });
});
