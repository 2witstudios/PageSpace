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

import { resolveAppRoute, type AppRouterDeps, type PublishedAppRouteRow } from '../router';

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
