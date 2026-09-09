import { describe, it, expect, beforeEach, vi } from 'vitest';

const { selectMock, insertMock, updateMock, deleteMock, errorMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  deleteMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    delete: deleteMock,
    transaction: async (fn: (tx: unknown) => unknown) =>
      // `execute` backs destroyPublishedApp's own `FOR UPDATE` lock on
      // `published_apps` (see dedicated-tier-service.ts's matching guard) —
      // a no-op here since none of these tests exercise the actual
      // concurrent-lock semantics, only that the call happens without
      // throwing.
      fn({ select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock, execute: vi.fn(async () => ({ rows: [] })) }),
  },
}));
vi.mock('@pagespace/db/schema/published-apps', () => ({
  publishedApps: {
    id: 'id',
    envId: 'envId',
    status: 'status',
    subdomain: 'subdomain',
    flyAppName: 'flyAppName',
    updatedAt: 'updatedAt',
    claimedAt: 'claimedAt',
    claimedBy: 'claimedBy',
  },
  appDeployTokenMints: { id: 'id', publishedAppId: 'publishedAppId' },
}));
// Distinct object identities, so a test can assert WHICH table a write targeted.
// `drive_envs` is read-only from here: publishing must never write the
// environment it serves.
vi.mock('@pagespace/db/schema/drive-envs', () => ({
  driveEnvs: { id: 'driveEnvs.id', driveId: 'driveEnvs.driveId' },
}));
vi.mock('@pagespace/db/schema/published-app-subscriptions', () => ({
  publishedAppSubscriptions: {
    publishedAppId: 'publishedAppSubscriptions.publishedAppId',
    stripeSubscriptionId: 'publishedAppSubscriptions.stripeSubscriptionId',
  },
}));
vi.mock('@pagespace/db/schema/app-hosting-stripe-reclaims', () => ({
  appHostingStripeReclaims: { stripeSubscriptionId: 'appHostingStripeReclaims.stripeSubscriptionId' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
  and: (...args: unknown[]) => ({ and: args }),
  or: (...args: unknown[]) => ({ or: args }),
  isNull: (a: unknown) => ({ isNull: a }),
  lt: (a: unknown, b: unknown) => ({ lt: [a, b] }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: [strings.raw, values] }),
}));
vi.mock('../../../logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: errorMock, debug: vi.fn() } },
}));

import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import {
  createPublishedApp,
  destroyPublishedApp,
  claimPublishedAppsForWork,
  releasePublishedAppClaim,
  mintDeployToken,
  transitionPublishedApp,
  findPublishedAppBySubdomain,
  type ProvisionerDeps,
} from '../provisioner';

/** A record of every DB/Fly interaction, in order — the ordering invariant is the thing under test. */
let callLog: string[] = [];
/** Every patch handed to `db.update().set()`, in order. */
let updatePatches: Record<string, unknown>[] = [];
/** Every row handed to `db.insert().values()`, in order. */
let insertedRows: Record<string, unknown>[] = [];
/** Every table handed to `db.select().from()`, in order. */
let selectedTables: unknown[] = [];
/** Every table handed to `db.insert()`, `db.update()` or `db.delete()`, in order. */
let writtenTables: unknown[] = [];
/** When true, the guarded insert returns nothing — i.e. another publish won the race. */
let insertConflicts = false;
/** Every `onConflictDoNothing({target})` the insert path asked for, in order. */
let conflictTargets: unknown[] = [];

/** The most recent `set()` patch. (`Array.prototype.at` is beyond this package's typecheck lib target.) */
const lastPatch = (): Record<string, unknown> => updatePatches[updatePatches.length - 1] ?? {};

function deps(overrides: Partial<ProvisionerDeps> = {}): ProvisionerDeps {
  return {
    isEnabled: () => true,
    resolveNetwork: () => 'published-apps',
    createFlyApp: async () => {
      callLog.push('fly:createApp');
    },
    deleteFlyApp: async () => {
      callLog.push('fly:deleteApp');
    },
    mintFlyDeployToken: async () => {
      callLog.push('fly:mintDeployToken');
      return 'FlyV1 fm2_aaa,fm2_bbb';
    },
    ...overrides,
  };
}

/**
 * db.select()…limit() resolving to `rows`.
 *
 * `.limit()` must be BOTH awaitable and chainable to `.for('update')`, because a
 * plain read awaits it while the locked read in transitionPublishedApp appends a
 * row lock — so it returns a thenable that also carries `.for`.
 */
function mockSelect(rows: unknown[], label = 'db:select'): void {
  mockSelectQueue([{ rows, label }]);
}

/**
 * Sequenced reads: the first `select()` gets the first batch, and the last batch
 * repeats once the queue runs out.
 *
 * `createPublishedApp` reads TWICE — the `drive_envs` row it is publishing (to
 * prove it exists and belongs to the drive whose id is about to be denormalized
 * onto the hosting row) and then the existing hosting row. One canned result for
 * both would let the env check pass against whatever the second read returns,
 * which is exactly the confusion the check exists to prevent.
 */
function mockSelectQueue(batches: { rows: unknown[]; label: string }[]): void {
  let call = 0;

  selectMock.mockImplementation(() => ({
    from: (table: unknown) => {
      const batch = batches[Math.min(call, batches.length - 1)];
      call += 1;
      selectedTables.push(table);

      const limitResult = () => {
        callLog.push(batch.label);
        const settled = Promise.resolve(batch.rows);
        return {
          for: () => {
            callLog.push('db:lock');
            return settled;
          },
          then: settled.then.bind(settled),
          catch: settled.catch.bind(settled),
          finally: settled.finally.bind(settled),
        };
      };

      return {
        where: () => ({
          limit: limitResult,
          orderBy: () => ({
            limit: () => ({
              for: () => {
                callLog.push('db:claim');
                return Promise.resolve(batch.rows);
              },
            }),
          }),
        }),
      };
    },
  }));
}

const NOW = new Date('2026-08-15T00:00:00Z');
/** The environment being published. Read, never written. */
const ENV = { id: 'env1', driveId: 'drive1' };
const ENV_READ = { rows: [ENV], label: 'db:select:env' };

const ROW = {
  id: 'app1',
  envId: 'env1',
  driveId: 'drive1',
  ownerId: 'user1',
  flyAppName: 'pgs-app-app1',
  networkName: 'published-apps',
  subdomain: 'acme',
  status: 'provisioning' as const,
  guestPreset: 'shared-cpu-1x-512',
  imageDigest: null,
  tier: 'metered' as const,
  machineId: null,
  lastWakeAt: null,
  lastStopAt: null,
  lastError: null,
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  callLog = [];
  updatePatches = [];
  insertedRows = [];
  selectedTables = [];
  writtenTables = [];
  insertConflicts = false;
  conflictTargets = [];
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
  errorMock.mockReset();

  insertMock.mockImplementation((table: unknown) => ({
    values: (row: Record<string, unknown>) => {
      writtenTables.push(table);
      callLog.push('db:insert');
      insertedRows.push(row);
      const result = {
        returning: () => Promise.resolve([{ ...ROW, ...row }]),
        // The conflict guard; `insertConflicts` makes this insert lose the race.
        // The target is recorded because WHICH constraint it names is the whole
        // point — a targetless guard would swallow a `subdomain` or
        // `flyAppName` collision as "already published".
        onConflictDoNothing: (config?: { target?: unknown }) => {
          conflictTargets.push(config?.target);
          return {
            returning: () => Promise.resolve(insertConflicts ? [] : [{ ...ROW, ...row }]),
          };
        },
        // mintDeployToken inserts without .returning()
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
      };
      return result;
    },
  }));
  updateMock.mockImplementation((table: unknown) => ({
    set: (patch: Record<string, unknown>) => ({
      where: () => {
        writtenTables.push(table);
        callLog.push(`db:update:${String(patch.status ?? 'fields')}`);
        updatePatches.push(patch);
        return {
          returning: () => Promise.resolve([{ ...ROW, ...patch }]),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
        };
      },
    }),
  }));
  deleteMock.mockImplementation((table: unknown) => ({
    where: () => {
      writtenTables.push(table);
      callLog.push('db:delete');
      return Promise.resolve(undefined);
    },
  }));
});

describe('the kill switch — every entry point is dark when off', () => {
  const off = deps({ isEnabled: () => false });

  it('given hosting is disabled, createPublishedApp denies and never reaches Fly', async () => {
    mockSelect([]);
    const result = await createPublishedApp({
      envId: 'env1',
      driveId: 'drive1',
      ownerId: 'user1',
      subdomain: 'acme',
      orgSlug: 'pagespace',
      deps: off,
    });
    expect(result).toEqual({ ok: false, reason: 'disabled' });
    expect(callLog.filter((c) => c.startsWith('fly:'))).toEqual([]);
    expect(callLog).not.toContain('db:insert');
  });

  it('given hosting is disabled, destroyPublishedApp denies', async () => {
    expect(await destroyPublishedApp('app1', off)).toEqual({ ok: false, reason: 'disabled' });
    expect(callLog.filter((c) => c.startsWith('fly:'))).toEqual([]);
  });

  it('given hosting is disabled, claimPublishedAppsForWork claims nothing', async () => {
    const claim = await claimPublishedAppsForWork({ statuses: ['building'], limit: 5, deps: off });
    expect(claim.apps).toEqual([]);
    expect(callLog).not.toContain('db:claim');
  });

  it('given hosting is disabled, transitionPublishedApp denies', async () => {
    expect(await transitionPublishedApp('app1', 'running', { deps: off })).toEqual({
      ok: false,
      reason: 'disabled',
    });
  });

  it('given hosting is disabled, createPublishedApp denies BEFORE touching the database', async () => {
    // A dark deployment is exactly the one where published_apps may not exist yet.
    // Querying first turns the documented denial into a thrown error.
    selectMock.mockImplementation(() => {
      throw new Error('relation "published_apps" does not exist');
    });

    const result = await createPublishedApp({
      envId: 'env1',
      driveId: 'drive1',
      ownerId: 'user1',
      subdomain: 'acme',
      orgSlug: 'pagespace',
      deps: off,
    });

    expect(result).toEqual({ ok: false, reason: 'disabled' });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('given hosting is disabled, releasePublishedAppClaim writes nothing', async () => {
    expect(await releasePublishedAppClaim(['app1'], 'token', off)).toBe(0);
    expect(callLog.filter((c) => c.startsWith('db:update'))).toEqual([]);
  });

  it('given hosting is disabled, mintDeployToken denies and mints nothing', async () => {
    expect(
      await mintDeployToken({ publishedAppId: 'app1', expiry: '48h', purpose: 'build', deps: off }),
    ).toEqual({ ok: false, reason: 'disabled' });
    expect(callLog.filter((c) => c.startsWith('fly:'))).toEqual([]);
  });

  it('given hosting is disabled, findPublishedAppBySubdomain returns null', async () => {
    expect(await findPublishedAppBySubdomain('acme', off)).toBeNull();
  });
});

describe('createPublishedApp — row before Fly', () => {
  it('given a fresh env, should INSERT the row before the first Fly call', async () => {
    mockSelectQueue([ENV_READ, { rows: [], label: 'db:select' }]);
    const result = await createPublishedApp({
      envId: 'env1',
      driveId: 'drive1',
      ownerId: 'user1',
      subdomain: 'acme',
      orgSlug: 'pagespace',
      deps: deps(),
    });

    expect(result.ok).toBe(true);
    // The whole safety property in one assertion: the pointer exists before the
    // billing resource. Reversing these leaves a Fly app nothing points at.
    expect(callLog.indexOf('db:insert')).toBeLessThan(callLog.indexOf('fly:createApp'));
  });

  it('given a fresh env, should create the Fly app on the SHARED network', async () => {
    mockSelectQueue([ENV_READ, { rows: [], label: 'db:select' }]);
    const seen: string[] = [];
    await createPublishedApp({
      envId: 'env1',
      driveId: 'drive1',
      ownerId: 'user1',
      subdomain: 'acme',
      orgSlug: 'pagespace',
      deps: deps({
        createFlyApp: async ({ network }) => {
          seen.push(network);
        },
      }),
    });
    expect(seen).toEqual(['published-apps']);
  });

  it('given Fly fails, should stamp the row failed and NEVER delete it', async () => {
    mockSelectQueue([ENV_READ, { rows: [], label: 'db:select' }]);
    const result = await createPublishedApp({
      envId: 'env1',
      driveId: 'drive1',
      ownerId: 'user1',
      subdomain: 'acme',
      orgSlug: 'pagespace',
      deps: deps({
        createFlyApp: async () => {
          throw new Error('fly exploded');
        },
      }),
    });

    expect(result).toEqual({ ok: false, reason: 'fly_error', error: 'fly exploded' });
    expect(callLog).toContain('db:update:failed');
    // Deleting the row would discard flyAppName — the only handle that can destroy
    // an app Fly may in fact have created before erroring.
    expect(callLog).not.toContain('db:delete');
    expect(errorMock).toHaveBeenCalled();
  });

  it('given an env that already has a running app, should no-op rather than create a second Fly app', async () => {
    mockSelectQueue([ENV_READ, { rows: [{ ...ROW, status: 'running' }], label: 'db:select' }]);
    const result = await createPublishedApp({
      envId: 'env1',
      driveId: 'drive1',
      ownerId: 'user1',
      subdomain: 'acme',
      orgSlug: 'pagespace',
      deps: deps(),
    });
    expect(result.ok).toBe(true);
    expect(callLog.filter((c) => c.startsWith('fly:'))).toEqual([]);
  });

  it('given a no-op, should return the row it already read rather than re-reading it', async () => {
    mockSelectQueue([ENV_READ, { rows: [{ ...ROW, status: 'running' }], label: 'db:select' }]);
    const result = await createPublishedApp({
      envId: 'env1',
      driveId: 'drive1',
      ownerId: 'user1',
      subdomain: 'acme',
      orgSlug: 'pagespace',
      deps: deps(),
    });

    // Two reads left a window in which the row could be deleted, and the no-op path
    // then returned `app: undefined` while typed as PublishedApp.
    expect(result).toEqual({ ok: true, app: { ...ROW, status: 'running' }, noop: true });
    expect(callLog.filter((c) => c === 'db:select')).toHaveLength(1);
  });

  it('given no such env, should refuse before writing anything', async () => {
    mockSelectQueue([{ rows: [], label: 'db:select:env' }]);
    const result = await createPublishedApp({
      envId: 'ghost',
      driveId: 'drive1',
      ownerId: 'user1',
      subdomain: 'acme',
      orgSlug: 'pagespace',
      deps: deps(),
    });

    expect(result).toEqual({ ok: false, reason: 'env_not_found' });
    expect(callLog).not.toContain('db:insert');
    expect(callLog.filter((c) => c.startsWith('fly:'))).toEqual([]);
  });

  it("given an env belonging to another drive, should refuse rather than denormalize the wrong drive", async () => {
    mockSelectQueue([{ rows: [{ id: 'env1', driveId: 'other-drive' }], label: 'db:select:env' }]);
    const result = await createPublishedApp({
      envId: 'env1',
      driveId: 'drive1',
      ownerId: 'user1',
      subdomain: 'acme',
      orgSlug: 'pagespace',
      deps: deps(),
    });

    // `driveId` is the copy billing and the claim queries trust. A row whose
    // denormalized drive disagrees with its env bills the wrong drive and is
    // invisible to the one that owns the app — the database cannot express the
    // agreement, so this is the only place it can be refused.
    expect(result).toEqual({ ok: false, reason: 'env_drive_mismatch' });
    expect(callLog).not.toContain('db:insert');
    expect(callLog.filter((c) => c.startsWith('fly:'))).toEqual([]);
  });

  it('given a concurrent publish that won the insert race, should return ITS row as a no-op rather than throw', async () => {
    insertConflicts = true;
    const winner = { ...ROW, id: 'app-winner', flyAppName: 'pgs-app-app-winner', status: 'building' as const };
    mockSelectQueue([
      ENV_READ,
      // The read that found nothing — the race is between this and the insert.
      { rows: [], label: 'db:select' },
      { rows: [winner], label: 'db:select' },
    ]);

    const result = await createPublishedApp({
      envId: 'env1',
      driveId: 'drive1',
      ownerId: 'user1',
      subdomain: 'acme',
      orgSlug: 'pagespace',
      deps: deps(),
    });

    // One env has one hosting row, so the loser's answer is the winner's row.
    // Continuing past the conflict would create a SECOND Fly app — the name is
    // derived from the id this call generated, which no row now carries.
    expect(result).toEqual({ ok: true, app: winner, noop: true });
    expect(callLog.filter((c) => c.startsWith('fly:'))).toEqual([]);
    // Narrow on purpose: only "this env is already published" is absorbed. A
    // targetless guard would also swallow a subdomain or flyAppName collision,
    // which are different resources and different problems.
    expect(conflictTargets).toEqual([publishedApps.envId]);
  });

  it('given the winning row is deleted before it can be read back, should refuse rather than invent one', async () => {
    insertConflicts = true;
    mockSelectQueue([
      ENV_READ,
      { rows: [], label: 'db:select' },
      { rows: [], label: 'db:select' },
    ]);

    const result = await createPublishedApp({
      envId: 'env1',
      driveId: 'drive1',
      ownerId: 'user1',
      subdomain: 'acme',
      orgSlug: 'pagespace',
      deps: deps(),
    });

    // Not `env_not_found`: which of "the env went away" and "someone
    // unpublished" happened is unknowable from here, and both leave the caller
    // in the same place — nothing was created, try again.
    expect(result).toEqual({ ok: false, reason: 'raced' });
    expect(callLog.filter((c) => c.startsWith('fly:'))).toEqual([]);
  });

  it('given a publish, should read the env and never write it', async () => {
    mockSelectQueue([ENV_READ, { rows: [], label: 'db:select' }]);
    await createPublishedApp({
      envId: 'env1',
      driveId: 'drive1',
      ownerId: 'user1',
      subdomain: 'acme',
      orgSlug: 'pagespace',
      deps: deps(),
    });

    // The hosting row hangs off the env; the env knows nothing about Fly. A write
    // in this direction would put a Fly pointer on a row whose only teardown
    // outbox is `machine_sprite_reclaims`, which cannot kill a Fly app.
    expect(selectedTables).toContain(driveEnvs);
    expect(writtenTables).not.toContain(driveEnvs);
  });
});

describe('destroyPublishedApp', () => {
  it('given a live app with no dedicated subscription, should mark destroying, delete on Fly, check for a subscription, then delete the row', async () => {
    // Two reads: the row itself (outside the transaction), then the
    // subscription lookup INSIDE the deleting transaction — the second batch
    // is empty, matching the common case of a metered (non-dedicated) app.
    mockSelectQueue([
      { rows: [ROW], label: 'db:select' },
      { rows: [], label: 'db:select:subscription' },
    ]);
    const result = await destroyPublishedApp('app1', deps());
    expect(result).toEqual({ ok: true });
    expect(callLog).toEqual(['db:select', 'db:update:destroying', 'fly:deleteApp', 'db:select:subscription', 'db:delete']);
    // No subscription found -> nothing written to the Stripe reclaim outbox.
    expect(callLog).not.toContain('db:insert');
  });

  it('given a live app WITH a dedicated subscription, writes the Stripe reclaim outbox row in the same transaction as the delete', async () => {
    mockSelectQueue([
      { rows: [ROW], label: 'db:select' },
      { rows: [{ stripeSubscriptionId: 'sub_123' }], label: 'db:select:subscription' },
    ]);
    const result = await destroyPublishedApp('app1', deps());
    expect(result).toEqual({ ok: true });
    expect(callLog).toEqual([
      'db:select',
      'db:update:destroying',
      'fly:deleteApp',
      'db:select:subscription',
      'db:insert',
      'db:delete',
    ]);
    expect(insertedRows).toContainEqual(
      expect.objectContaining({ stripeSubscriptionId: 'sub_123', publishedAppId: 'app1' }),
    );
  });

  it('given the Fly delete fails, should keep the row so the teardown can be retried', async () => {
    mockSelect([ROW]);
    const result = await destroyPublishedApp(
      'app1',
      deps({
        deleteFlyApp: async () => {
          throw new Error('fly down');
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: 'fly_error', error: 'fly down' });
    expect(callLog).not.toContain('db:delete');
  });

  it('given no such app, should report not_found without calling Fly', async () => {
    mockSelect([]);
    expect(await destroyPublishedApp('nope', deps())).toEqual({ ok: false, reason: 'not_found' });
    expect(callLog.filter((c) => c.startsWith('fly:'))).toEqual([]);
  });

  it('given a teardown, should leave the environment entirely alone', async () => {
    mockSelectQueue([
      { rows: [ROW], label: 'db:select' },
      { rows: [], label: 'db:select:subscription' },
    ]);
    await destroyPublishedApp('app1', deps());

    // Unpublishing is not deleting an environment: the env keeps its Sprite, its
    // sessions and its contents, and can be published again. The cascade runs one
    // way only — deleting the env destroys the hosting row, never the reverse.
    expect(writtenTables).not.toContain(driveEnvs);
    expect(selectedTables).not.toContain(driveEnvs);
  });
});

describe('transitionPublishedApp', () => {
  const SERVING = { imageDigest: 'sha256:abc', machineId: 'm1' };

  it('given a legal edge, should persist the new status', async () => {
    mockSelect([{ ...ROW, status: 'deploying', ...SERVING }]);
    const result = await transitionPublishedApp('app1', 'running', { deps: deps() });
    expect(result.ok).toBe(true);
  });

  it('given an illegal edge, should refuse and write nothing', async () => {
    mockSelect([{ ...ROW, status: 'provisioning' }]);
    const result = await transitionPublishedApp('app1', 'running', { deps: deps() });
    expect(result).toEqual({ ok: false, reason: 'illegal_transition' });
    expect(callLog.filter((c) => c.startsWith('db:update'))).toEqual([]);
  });

  it('given a destroying app, should refuse to resurrect it', async () => {
    mockSelect([{ ...ROW, status: 'destroying' }]);
    expect(await transitionPublishedApp('app1', 'running', { deps: deps() })).toEqual({
      ok: false,
      reason: 'terminal_state',
    });
  });

  it('given deploying -> running with no machine id, should REFUSE rather than let the CHECK raise', async () => {
    mockSelect([{ ...ROW, status: 'deploying', imageDigest: 'sha256:abc', machineId: null }]);
    const result = await transitionPublishedApp('app1', 'running', { deps: deps() });
    // published_apps_running_requires_machine would reject this write. A thrown
    // constraint violation aborts the caller's transaction; every entry point here
    // is documented as returning a denial instead.
    expect(result).toEqual({ ok: false, reason: 'running_requires_machine' });
    expect(callLog.filter((c) => c.startsWith('db:update'))).toEqual([]);
  });

  it('given deploying -> running with no image digest, should refuse as serving_requires_image', async () => {
    mockSelect([{ ...ROW, status: 'deploying', imageDigest: null, machineId: 'm1' }]);
    expect(await transitionPublishedApp('app1', 'running', { deps: deps() })).toEqual({
      ok: false,
      reason: 'serving_requires_image',
    });
  });

  it('given the machine id supplied in the patch, should allow the transition and write both columns at once', async () => {
    mockSelect([{ ...ROW, status: 'deploying', imageDigest: 'sha256:abc', machineId: null }]);
    const result = await transitionPublishedApp('app1', 'running', {
      patch: { machineId: 'm7' },
      deps: deps(),
    });

    expect(result.ok).toBe(true);
    // Same statement, or the CHECK rejects whichever half lands first.
    expect(lastPatch()).toEqual({ status: 'running', machineId: 'm7' });
  });

  it('given a dedicated app being parked, should refuse — parking is a credit action a flat SKU never takes', async () => {
    mockSelect([{ ...ROW, status: 'running', tier: 'dedicated', ...SERVING }]);
    expect(await transitionPublishedApp('app1', 'parked', { deps: deps() })).toEqual({
      ok: false,
      reason: 'parked_is_metered_only',
    });
  });

  it('given a teardown of a row with neither column, should still allow it', async () => {
    mockSelect([{ ...ROW, status: 'provisioning', imageDigest: null, machineId: null }]);
    const result = await transitionPublishedApp('app1', 'destroying', { deps: deps() });
    expect(result.ok).toBe(true);
  });
});

describe('claimPublishedAppsForWork', () => {
  it('given no statuses, should claim nothing rather than lock the whole table', async () => {
    mockSelect([ROW]);
    const claim = await claimPublishedAppsForWork({ statuses: [], limit: 10, deps: deps() });
    expect(claim.apps).toEqual([]);
    expect(callLog).not.toContain('db:claim');
  });

  it('given statuses, should claim rows with a skip-locked read', async () => {
    mockSelect([ROW]);
    const claim = await claimPublishedAppsForWork({
      statuses: ['building'],
      limit: 10,
      deps: deps(),
    });
    expect(claim.apps).toHaveLength(1);
    expect(callLog).toContain('db:claim');
  });

  it('given claimed rows, should WRITE the claim inside the same transaction — the lock dies at commit', async () => {
    mockSelect([ROW]);
    const claim = await claimPublishedAppsForWork({
      statuses: ['building'],
      limit: 10,
      deps: deps(),
    });

    // Without this write the transaction commits, the FOR UPDATE locks release,
    // and the very next worker receives the same rows — before this caller has
    // done any work with them.
    expect(callLog).toContain('db:update:fields');
    expect(callLog.indexOf('db:claim')).toBeLessThan(callLog.indexOf('db:update:fields'));
    const patch = lastPatch();
    expect(Object.keys(patch).sort()).toEqual(['claimedAt', 'claimedBy']);
    expect(patch.claimedBy).toBe(claim.token);
  });

  it('given nothing to claim, should not write a claim marker at all', async () => {
    mockSelect([]);
    const claim = await claimPublishedAppsForWork({
      statuses: ['building'],
      limit: 10,
      deps: deps(),
    });
    expect(claim.apps).toEqual([]);
    expect(callLog.filter((c) => c.startsWith('db:update'))).toEqual([]);
  });

  it('given two claims, should mint different tokens so one worker can never release the other', async () => {
    mockSelect([ROW]);
    const first = await claimPublishedAppsForWork({ statuses: ['building'], limit: 1, deps: deps() });
    const second = await claimPublishedAppsForWork({ statuses: ['building'], limit: 1, deps: deps() });
    expect(first.token).not.toBe(second.token);
  });

  it('given the claim query, should ask for skipLocked so a second worker moves on rather than blocking', async () => {
    const forArgs: unknown[][] = [];
    selectMock.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              for: (...args: unknown[]) => {
                forArgs.push(args);
                return Promise.resolve([ROW]);
              },
            }),
          }),
        }),
      }),
    }));
    await claimPublishedAppsForWork({ statuses: ['building'], limit: 10, deps: deps() });
    expect(forArgs).toEqual([['update', { skipLocked: true }]]);
  });
});

describe('releasePublishedAppClaim', () => {
  it('given a token, should fence the release on it so a superseded worker cannot free the new holder', async () => {
    const wheres: unknown[] = [];
    updateMock.mockImplementation(() => ({
      set: (patch: Record<string, unknown>) => ({
        where: (condition: unknown) => {
          wheres.push(condition);
          updatePatches.push(patch);
          return { returning: () => Promise.resolve([{ id: 'app1' }]) };
        },
      }),
    }));

    const released = await releasePublishedAppClaim(['app1'], 'token-a', deps());

    expect(released).toBe(1);
    expect(lastPatch()).toEqual({ claimedAt: null, claimedBy: null });
    // The predicate carries the token, not just the ids.
    expect(JSON.stringify(wheres)).toContain('token-a');
  });

  it('given no ids, should not issue a write at all', async () => {
    expect(await releasePublishedAppClaim([], 'token-a', deps())).toBe(0);
    expect(callLog.filter((c) => c.startsWith('db:update'))).toEqual([]);
  });
});

describe('mintDeployToken', () => {
  it('given a successful mint, should record it and return the token', async () => {
    mockSelect([{ id: 'app1', flyAppName: 'pgs-app-app1' }]);
    const result = await mintDeployToken({
      publishedAppId: 'app1',
      expiry: '48h',
      purpose: 'build',
      deps: deps(),
    });

    expect(result).toEqual({ ok: true, token: 'FlyV1 fm2_aaa,fm2_bbb' });
    // Fly returns no token id, so the mint record is the only evidence this
    // credential was ever created — writing it is part of minting.
    expect(callLog).toContain('db:insert');
  });

  it('given a mint, should write the audit row BEFORE calling Fly', async () => {
    mockSelect([{ id: 'app1', flyAppName: 'pgs-app-app1' }]);
    await mintDeployToken({
      publishedAppId: 'app1',
      expiry: '48h',
      purpose: 'build',
      deps: deps(),
    });

    // A crash between the mint and the record loses the ONLY evidence that a live,
    // self-renewing, app-scoped credential exists. Recording first inverts the loss
    // into a row for a token that was never issued.
    expect(callLog.indexOf('db:insert')).toBeLessThan(callLog.indexOf('fly:mintDeployToken'));
    expect(insertedRows[insertedRows.length - 1]).toMatchObject({ outcome: 'pending' });
  });

  it('given a successful mint, should settle the audit row to minted', async () => {
    mockSelect([{ id: 'app1', flyAppName: 'pgs-app-app1' }]);
    await mintDeployToken({
      publishedAppId: 'app1',
      expiry: '48h',
      purpose: 'build',
      deps: deps(),
    });

    const settle = lastPatch();
    expect(settle.outcome).toBe('minted');
    expect(settle.settledAt).toBeDefined();
    expect(callLog.indexOf('fly:mintDeployToken')).toBeLessThan(
      callLog.lastIndexOf('db:update:fields'),
    );
  });

  it('given the settle write fails, should still return the token and log the unsettled row', async () => {
    mockSelect([{ id: 'app1', flyAppName: 'pgs-app-app1' }]);
    updateMock.mockImplementation(() => ({
      set: () => ({
        where: () => Promise.reject(new Error('db gone')),
      }),
    }));

    const result = await mintDeployToken({
      publishedAppId: 'app1',
      expiry: '48h',
      purpose: 'build',
      deps: deps(),
    });

    // The credential exists; `pending` already says "a token may exist for this
    // app", which is the fact worth keeping. Losing the caller's token as well
    // would strand it with no upside.
    expect(result).toEqual({ ok: true, token: 'FlyV1 fm2_aaa,fm2_bbb' });
    expect(errorMock).toHaveBeenCalled();
  });

  it('given a successful mint, should NOT persist the token value', async () => {
    mockSelect([{ id: 'app1', flyAppName: 'pgs-app-app1' }]);
    const inserted: Record<string, unknown>[] = [];
    insertMock.mockImplementation(() => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row);
        return Promise.resolve(undefined);
      },
    }));

    await mintDeployToken({
      publishedAppId: 'app1',
      expiry: '48h',
      purpose: 'build',
      deps: deps(),
    });

    expect(inserted).toHaveLength(1);
    const serialised = JSON.stringify(inserted[0]);
    // Storing a self-renewing app-scoped credential would make the audit table
    // worth more to an attacker than the apps it documents.
    expect(serialised).not.toContain('FlyV1');
    expect(serialised).not.toContain('fm2_');
    expect(inserted[0]).toMatchObject({
      publishedAppId: 'app1',
      flyAppName: 'pgs-app-app1',
      expiry: '48h',
      purpose: 'build',
    });
  });

  it('given the Fly mint fails, should settle the attempt as failed rather than erase it', async () => {
    mockSelect([{ id: 'app1', flyAppName: 'pgs-app-app1' }]);
    const result = await mintDeployToken({
      publishedAppId: 'app1',
      expiry: '48h',
      purpose: 'build',
      deps: deps({
        mintFlyDeployToken: async () => {
          throw new Error('fly refused');
        },
      }),
    });

    expect(result).toEqual({ ok: false, reason: 'fly_error', error: 'fly refused' });
    // An error that arrived after the mint committed would still leave a token, so
    // the attempt stays on the record — settled, not deleted.
    expect(callLog).toContain('db:insert');
    expect(lastPatch()).toMatchObject({ outcome: 'failed' });
  });

  it('given BOTH the Fly mint and the settle write fail, should still return the denial rather than throw', async () => {
    mockSelect([{ id: 'app1', flyAppName: 'pgs-app-app1' }]);
    updateMock.mockImplementation(() => ({
      set: () => ({ where: () => Promise.reject(new Error('db gone')) }),
    }));

    // Bookkeeping runs after the outcome is decided. A failed settle must not
    // replace the reason Fly gave with a thrown database error — every entry point
    // here is documented as returning a value.
    const result = await mintDeployToken({
      publishedAppId: 'app1',
      expiry: '48h',
      purpose: 'build',
      deps: deps({
        mintFlyDeployToken: async () => {
          throw new Error('fly refused');
        },
      }),
    });

    expect(result).toEqual({ ok: false, reason: 'fly_error', error: 'fly refused' });
    expect(errorMock).toHaveBeenCalled();
  });

  it('given no such app, should report not_found', async () => {
    mockSelect([]);
    expect(
      await mintDeployToken({ publishedAppId: 'nope', expiry: '48h', purpose: 'build', deps: deps() }),
    ).toEqual({ ok: false, reason: 'not_found' });
  });
});
