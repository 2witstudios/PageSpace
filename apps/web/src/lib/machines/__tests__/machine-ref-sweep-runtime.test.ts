/**
 * Unit tests for the dangling-MachineRef sweep's DB wiring (issue #2156).
 *
 * The decisions live in the pure core (@pagespace/lib services/machines/
 * machine-ref-sweep, separately tested to 100% branches); what THIS module owns
 * — and what these tests pin — is the wiring:
 *
 * - liveness is "a `pages` row exists", with NO isTrashed filter (a trashed
 *   Machine is restorable, so its refs must survive the sweep);
 * - agent blobs are rewritten through the canonical `applyPageMutation` with a
 *   revision CAS and a REAL actor (the page's drive owner) — never a raw
 *   `db.update`, which would skip the revision bump/version/activity entry;
 * - the global-assistant blob has no revision to CAS on, so its rewrite re-reads
 *   the row under `SELECT … FOR UPDATE` and re-applies the same dead set, rather
 *   than clobbering a concurrent settings save with a stale array.
 *
 * DB access is mocked; these tests verify routing, filtering and locking.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockApplyPageMutation,
  mockGetActorInfo,
  mockPagesSelectWhere,
  mockGlobalSelectWhere,
  mockFindDrive,
  mockExecute,
  mockTxGlobalSelectFor,
  mockTxUpdateSet,
  mockTxUpdateWhere,
} = vi.hoisted(() => ({
  mockApplyPageMutation: vi.fn(),
  mockGetActorInfo: vi.fn(),
  mockPagesSelectWhere: vi.fn(),
  mockGlobalSelectWhere: vi.fn(),
  mockFindDrive: vi.fn(),
  mockExecute: vi.fn(),
  mockTxGlobalSelectFor: vi.fn(),
  mockTxUpdateSet: vi.fn(),
  mockTxUpdateWhere: vi.fn(),
}));

function tableName(table: unknown): string {
  return (table as { __table?: string } | undefined)?.__table ?? '';
}

const tx = {
  select: () => ({
    from: () => ({
      where: () => ({ for: (...args: unknown[]) => mockTxGlobalSelectFor(...args) }),
    }),
  }),
  update: () => ({
    set: (values: unknown) => {
      mockTxUpdateSet(values);
      return { where: (...args: unknown[]) => mockTxUpdateWhere(...args) };
    },
  }),
};

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: (...args: unknown[]) =>
          tableName(table) === 'global_assistant_config'
            ? mockGlobalSelectWhere(...args)
            : mockPagesSelectWhere(...args),
      }),
    }),
    query: { drives: { findFirst: (...args: unknown[]) => mockFindDrive(...args) } },
    execute: (...args: unknown[]) => mockExecute(...args),
    transaction: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  inArray: vi.fn((...args: unknown[]) => ({ inArray: args })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values })),
    { raw: vi.fn((text: string) => ({ raw: text })) },
  ),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: {
    __table: 'pages',
    id: 'id',
    type: 'type',
    driveId: 'driveId',
    revision: 'revision',
    machines: 'machines',
    machineAccess: 'machineAccess',
    isTrashed: 'isTrashed',
  },
  drives: { __table: 'drives', id: 'id', ownerId: 'ownerId' },
}));
vi.mock('@pagespace/db/schema/integrations', () => ({
  globalAssistantConfig: {
    __table: 'global_assistant_config',
    userId: 'userId',
    machines: 'machines',
    machineAccess: 'machineAccess',
  },
}));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: (...args: unknown[]) => mockGetActorInfo(...args),
}));
vi.mock('@/services/api/page-mutation-service', () => ({
  applyPageMutation: (...args: unknown[]) => mockApplyPageMutation(...args),
}));

import {
  sweepDanglingMachineRefs,
  collectMachinePageIdsInSubtree,
  collectMachinePageIdsInDrive,
} from '../machine-ref-sweep-runtime';

const DEAD = 'machine-gone';
const LIVE = 'machine-live';

const AGENT_ROW = {
  pageId: 'agent-1',
  revision: 7,
  driveId: 'drive-1',
  entries: [{ kind: 'existing', machineId: DEAD }],
  machineAccess: true,
};
const GLOBAL_ROW = {
  userId: 'user-1',
  entries: [{ kind: 'existing', machineId: DEAD }],
  machineAccess: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActorInfo.mockResolvedValue({ actorEmail: 'owner@x.test', actorDisplayName: 'Owner' });
  mockFindDrive.mockResolvedValue({ ownerId: 'drive-owner-1' });
  mockApplyPageMutation.mockResolvedValue({});
  mockGlobalSelectWhere.mockResolvedValue([GLOBAL_ROW]);
  mockTxGlobalSelectFor.mockResolvedValue([{ machines: GLOBAL_ROW.entries, machineAccess: true }]);
  mockTxUpdateWhere.mockResolvedValue(undefined);
  // First pages query = the agent listing; second = the liveness lookup, which
  // finds nothing (DEAD really is gone).
  mockPagesSelectWhere.mockResolvedValueOnce([AGENT_ROW]).mockResolvedValue([]);
});

describe('sweepDanglingMachineRefs', () => {
  it('rewrites an agent blob through applyPageMutation with a revision CAS and the drive owner as actor', async () => {
    const result = await sweepDanglingMachineRefs();

    expect(result.deadMachineIds).toEqual([DEAD]);
    expect(result.agentsUpdated).toBe(1);
    expect(mockApplyPageMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: 'agent-1',
        operation: 'agent_config_update',
        // The scrub empties the list, so access must go off with it — otherwise
        // resolveConfiguredMachines falls back to {kind:'own'}.
        updates: { machines: [], machineAccess: false },
        updatedFields: ['machines', 'machineAccess'],
        expectedRevision: 7,
        context: expect.objectContaining({
          userId: 'drive-owner-1',
          changeGroupType: 'system',
          resourceType: 'agent',
          metadata: { cascade: 'machine_purge', machineIds: [DEAD] },
        }),
      }),
    );
  });

  it('leaves machineAccess alone when refs survive the rewrite', async () => {
    mockPagesSelectWhere.mockReset();
    mockPagesSelectWhere
      .mockResolvedValueOnce([
        { ...AGENT_ROW, entries: [{ kind: 'existing', machineId: DEAD }, { kind: 'existing', machineId: LIVE }] },
      ])
      .mockResolvedValue([{ id: LIVE }]);
    mockGlobalSelectWhere.mockResolvedValue([]);

    await sweepDanglingMachineRefs();

    expect(mockApplyPageMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        updates: { machines: [{ kind: 'existing', machineId: LIVE }] },
        updatedFields: ['machines'],
      }),
    );
  });

  it('counts a rejected agent write as a failure without aborting the sweep', async () => {
    mockApplyPageMutation.mockRejectedValue(new Error('revision moved'));

    const result = await sweepDanglingMachineRefs();

    expect(result.failures).toBe(1);
    expect(result.agentsUpdated).toBe(0);
    // The global blob is still repaired.
    expect(result.globalConfigsUpdated).toBe(1);
  });

  it('fails the agent write rather than inventing an actor when the drive has no owner', async () => {
    mockFindDrive.mockResolvedValue(undefined);

    const result = await sweepDanglingMachineRefs();

    expect(mockApplyPageMutation).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
  });

  it('rewrites the global blob under a row lock, re-reading it inside the transaction', async () => {
    const result = await sweepDanglingMachineRefs();

    expect(mockTxGlobalSelectFor).toHaveBeenCalledWith('update');
    expect(mockTxUpdateSet).toHaveBeenCalledWith({ machines: [], machineAccess: false });
    expect(result.globalConfigsUpdated).toBe(1);
  });

  it('re-applies the dead set to what the lock actually found, not to the stale read', async () => {
    // A concurrent settings save added a live machine between the listing and
    // the lock: the sweep must drop only the dead ref, keeping the new one.
    mockTxGlobalSelectFor.mockResolvedValue([
      {
        machines: [{ kind: 'existing', machineId: DEAD }, { kind: 'existing', machineId: LIVE }],
        machineAccess: true,
      },
    ]);

    await sweepDanglingMachineRefs();

    expect(mockTxUpdateSet).toHaveBeenCalledWith({
      machines: [{ kind: 'existing', machineId: LIVE }],
      machineAccess: true,
    });
  });

  it('writes nothing when the locked row no longer holds a dead ref', async () => {
    mockTxGlobalSelectFor.mockResolvedValue([{ machines: [{ kind: 'own' }], machineAccess: true }]);

    const result = await sweepDanglingMachineRefs();

    expect(mockTxUpdateSet).not.toHaveBeenCalled();
    expect(result.globalConfigsUpdated).toBe(0);
  });

  it('writes nothing when the config row vanished under the lock', async () => {
    mockTxGlobalSelectFor.mockResolvedValue([]);

    const result = await sweepDanglingMachineRefs();

    expect(mockTxUpdateSet).not.toHaveBeenCalled();
    expect(result.globalConfigsUpdated).toBe(0);
  });

  it('is a no-op for an empty candidate list, without touching the database', async () => {
    const result = await sweepDanglingMachineRefs([]);

    expect(result).toEqual({ deadMachineIds: [], agentsUpdated: 0, globalConfigsUpdated: 0, failures: 0 });
    expect(mockPagesSelectWhere).not.toHaveBeenCalled();
    expect(mockGlobalSelectWhere).not.toHaveBeenCalled();
  });
});

describe('collectMachinePageIdsInSubtree', () => {
  it('returns the MACHINE page ids under a root, including the root itself', async () => {
    mockExecute.mockResolvedValue({ rows: [{ id: 'm1' }, { id: 'm2' }] });
    await expect(collectMachinePageIdsInSubtree('root-1')).resolves.toEqual(['m1', 'm2']);
  });
});

describe('collectMachinePageIdsInDrive', () => {
  it('returns every MACHINE page id in the drive', async () => {
    mockPagesSelectWhere.mockReset();
    mockPagesSelectWhere.mockResolvedValue([{ id: 'm1' }]);
    await expect(collectMachinePageIdsInDrive('drive-1')).resolves.toEqual(['m1']);
  });
});
