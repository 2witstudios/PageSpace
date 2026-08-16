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
      fn({ select: selectMock, update: updateMock }),
  },
}));
vi.mock('@pagespace/db/schema/published-apps', () => ({
  publishedApps: {
    id: 'id',
    pageId: 'pageId',
    status: 'status',
    subdomain: 'subdomain',
    flyAppName: 'flyAppName',
    updatedAt: 'updatedAt',
  },
  appDeployTokenMints: { publishedAppId: 'publishedAppId' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
}));
vi.mock('../../../logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: errorMock, debug: vi.fn() } },
}));

import {
  createPublishedApp,
  destroyPublishedApp,
  claimPublishedAppsForWork,
  mintDeployToken,
  transitionPublishedApp,
  findPublishedAppBySubdomain,
  type ProvisionerDeps,
} from '../provisioner';

/** A record of every DB/Fly interaction, in order — the ordering invariant is the thing under test. */
let callLog: string[] = [];

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
  const limitResult = () => {
    callLog.push(label);
    const settled = Promise.resolve(rows);
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

  selectMock.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: limitResult,
        orderBy: () => ({
          limit: () => ({
            for: () => {
              callLog.push('db:claim');
              return Promise.resolve(rows);
            },
          }),
        }),
      }),
    }),
  }));
}

const NOW = new Date('2026-08-15T00:00:00Z');
const ROW = {
  id: 'app1',
  pageId: 'page1',
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
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
  errorMock.mockReset();

  insertMock.mockImplementation(() => ({
    values: (row: Record<string, unknown>) => {
      callLog.push('db:insert');
      return {
        returning: () => Promise.resolve([{ ...ROW, ...row }]),
        // mintDeployToken inserts without .returning()
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
      };
    },
  }));
  updateMock.mockImplementation(() => ({
    set: (patch: Record<string, unknown>) => ({
      where: () => {
        callLog.push(`db:update:${String(patch.status ?? 'fields')}`);
        return {
          returning: () => Promise.resolve([{ ...ROW, ...patch }]),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
        };
      },
    }),
  }));
  deleteMock.mockImplementation(() => ({
    where: () => {
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
      pageId: 'page1',
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

  it('given hosting is disabled, claimPublishedAppsForWork returns nothing', async () => {
    expect(await claimPublishedAppsForWork({ statuses: ['building'], limit: 5, deps: off })).toEqual([]);
  });

  it('given hosting is disabled, transitionPublishedApp denies', async () => {
    expect(await transitionPublishedApp('app1', 'running', off)).toEqual({
      ok: false,
      reason: 'disabled',
    });
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
  it('given a fresh page, should INSERT the row before the first Fly call', async () => {
    mockSelect([]);
    const result = await createPublishedApp({
      pageId: 'page1',
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

  it('given a fresh page, should create the Fly app on the SHARED network', async () => {
    mockSelect([]);
    const seen: string[] = [];
    await createPublishedApp({
      pageId: 'page1',
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
    mockSelect([]);
    const result = await createPublishedApp({
      pageId: 'page1',
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

  it('given a page that already has a running app, should no-op rather than create a second Fly app', async () => {
    mockSelect([{ ...ROW, status: 'running' }]);
    const result = await createPublishedApp({
      pageId: 'page1',
      driveId: 'drive1',
      ownerId: 'user1',
      subdomain: 'acme',
      orgSlug: 'pagespace',
      deps: deps(),
    });
    expect(result.ok).toBe(true);
    expect(callLog.filter((c) => c.startsWith('fly:'))).toEqual([]);
  });
});

describe('destroyPublishedApp', () => {
  it('given a live app, should mark destroying, delete on Fly, then delete the row', async () => {
    mockSelect([ROW]);
    const result = await destroyPublishedApp('app1', deps());
    expect(result).toEqual({ ok: true });
    expect(callLog).toEqual(['db:select', 'db:update:destroying', 'fly:deleteApp', 'db:delete']);
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
});

describe('transitionPublishedApp', () => {
  it('given a legal edge, should persist the new status', async () => {
    mockSelect([{ ...ROW, status: 'deploying' }]);
    const result = await transitionPublishedApp('app1', 'running', deps());
    expect(result.ok).toBe(true);
  });

  it('given an illegal edge, should refuse and write nothing', async () => {
    mockSelect([{ ...ROW, status: 'provisioning' }]);
    const result = await transitionPublishedApp('app1', 'running', deps());
    expect(result).toEqual({ ok: false, reason: 'illegal_transition' });
    expect(callLog.filter((c) => c.startsWith('db:update'))).toEqual([]);
  });

  it('given a destroying app, should refuse to resurrect it', async () => {
    mockSelect([{ ...ROW, status: 'destroying' }]);
    expect(await transitionPublishedApp('app1', 'running', deps())).toEqual({
      ok: false,
      reason: 'terminal_state',
    });
  });
});

describe('claimPublishedAppsForWork', () => {
  it('given no statuses, should claim nothing rather than lock the whole table', async () => {
    mockSelect([ROW]);
    expect(await claimPublishedAppsForWork({ statuses: [], limit: 10, deps: deps() })).toEqual([]);
    expect(callLog).not.toContain('db:claim');
  });

  it('given statuses, should claim rows with a skip-locked read', async () => {
    mockSelect([ROW]);
    const rows = await claimPublishedAppsForWork({
      statuses: ['building'],
      limit: 10,
      deps: deps(),
    });
    expect(rows).toEqual([ROW]);
    expect(callLog).toContain('db:claim');
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

  it('given the Fly mint fails, should record nothing', async () => {
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
    expect(callLog).not.toContain('db:insert');
  });

  it('given no such app, should report not_found', async () => {
    mockSelect([]);
    expect(
      await mintDeployToken({ publishedAppId: 'nope', expiry: '48h', purpose: 'build', deps: deps() }),
    ).toEqual({ ok: false, reason: 'not_found' });
  });
});
