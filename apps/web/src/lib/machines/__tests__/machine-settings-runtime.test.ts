/**
 * Unit tests for the Machine Settings runtime wiring — the delete-path seams:
 *
 * - `createDbMachineSettingsStore().trashPage` must route through the CANONICAL
 *   `pageService.trashPage` (descendant cascade-trash, revision bump + page
 *   version, page-trash workflow triggers — all of which are that service's
 *   own tested behavior), not a raw `pageRepository.trash`, and must stay a
 *   SOFT delete so restore keeps working.
 * - `createDbMachineRefScrub().scrub` must remove the deleted machineId from
 *   referencing AI_CHAT agents' `machines` arrays (through the canonical
 *   `applyPageMutation`), disabling `machineAccess` when the last ref goes
 *   (an empty list with access on silently falls back to {kind:'own'}), and
 *   rewrite `global_assistant_config.machines` the same way.
 * - `createMachineSpriteTeardown().teardown` must free the compute of EVERY
 *   Machine page the cascade-trash hides — nested Machines included — branch
 *   Sprites before each machine's own Sprite.
 *
 * DB access and the canonical services are mocked; these tests verify THIS
 * module's routing, filtering, and traversal logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockTrashPage,
  mockApplyPageMutation,
  mockGetActorInfo,
  mockBroadcastPageEvent,
  mockCreatePageEventPayload,
  mockSelectWhere,
  mockUpdateSet,
  mockUpdateWhere,
  mockFindPage,
  mockFindDrive,
  mockSessionFind,
  mockSessionRemove,
  mockHostKill,
} = vi.hoisted(() => ({
  mockTrashPage: vi.fn(),
  mockApplyPageMutation: vi.fn(),
  mockGetActorInfo: vi.fn(),
  mockBroadcastPageEvent: vi.fn(),
  mockCreatePageEventPayload: vi.fn((...args: unknown[]) => {
    const [driveId, pageId, event, payload] = args;
    return { driveId, pageId, event, payload };
  }),
  mockSelectWhere: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockFindPage: vi.fn(),
  mockFindDrive: vi.fn(),
  mockSessionFind: vi.fn(),
  mockSessionRemove: vi.fn(),
  mockHostKill: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: (...args: unknown[]) => mockSelectWhere(...args) }) }),
    update: () => ({
      set: (values: unknown) => {
        mockUpdateSet(values);
        return { where: (...args: unknown[]) => mockUpdateWhere(...args) };
      },
    }),
    query: {
      pages: { findFirst: (...args: unknown[]) => mockFindPage(...args) },
      drives: { findFirst: (...args: unknown[]) => mockFindDrive(...args) },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  inArray: vi.fn((...args: unknown[]) => ({ inArray: args })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values })),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: {
    id: 'id',
    type: 'type',
    parentId: 'parentId',
    revision: 'revision',
    machines: 'machines',
    machineAccess: 'machineAccess',
    isTrashed: 'isTrashed',
  },
  drives: { id: 'id', ownerId: 'ownerId' },
}));
vi.mock('@pagespace/db/schema/integrations', () => ({
  globalAssistantConfig: { machines: 'machines', machineAccess: 'machineAccess' },
}));
vi.mock('@pagespace/db/schema/machine-branches', () => ({
  machineBranches: { machineId: 'machineId', sandboxId: 'sandboxId' },
}));
vi.mock('@pagespace/lib/services/sandbox/machine-session-manager', () => ({
  createDbMachineSessionStore: vi.fn(async () => ({
    findBySessionKey: (...args: unknown[]) => mockSessionFind(...args),
    remove: (...args: unknown[]) => mockSessionRemove(...args),
  })),
  deriveMachineSessionKey: vi.fn((input: { pageId: string }) => `key-${input.pageId}`),
  getSandboxSessionSecret: vi.fn(() => 'secret'),
}));
vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: (...args: unknown[]) => mockBroadcastPageEvent(...args),
  createPageEventPayload: (...args: unknown[]) => mockCreatePageEventPayload(...args),
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserDeletePage: vi.fn(),
}));
vi.mock('@pagespace/lib/content/page-types.config', () => ({
  isMachinePage: vi.fn((type: string) => type === 'MACHINE'),
}));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: (...args: unknown[]) => mockGetActorInfo(...args),
}));
vi.mock('@/services/api/page-service', () => ({
  pageService: { trashPage: (...args: unknown[]) => mockTrashPage(...args) },
}));
vi.mock('@/services/api/page-mutation-service', () => ({
  applyPageMutation: (...args: unknown[]) => mockApplyPageMutation(...args),
}));
vi.mock('../machine-branches-runtime', () => ({
  getMachineHostForBranches: vi.fn(async () => ({ kill: (...args: unknown[]) => mockHostKill(...args) })),
}));
vi.mock('../machine-access-runtime', () => ({
  canViewMachine: vi.fn(),
  canEditMachine: vi.fn(),
}));

import {
  createDbMachineSettingsStore,
  createDbMachineRefScrub,
  createMachineSpriteTeardown,
} from '../machine-settings-runtime';

const USER = 'user-1';
const MACHINE = 'machine-1';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActorInfo.mockResolvedValue({ actorEmail: 'jono@x.test', actorDisplayName: 'Jono' });
  mockSelectWhere.mockResolvedValue([]);
  mockUpdateWhere.mockResolvedValue(undefined);
  mockApplyPageMutation.mockResolvedValue({});
  mockFindPage.mockResolvedValue({ driveId: 'drive-1' });
  mockFindDrive.mockResolvedValue({ ownerId: 'tenant-1' });
  mockSessionFind.mockImplementation(async (key: string) => ({ sandboxId: `own-${key}` }));
  mockSessionRemove.mockResolvedValue(undefined);
  mockHostKill.mockResolvedValue(undefined);
});

describe('createDbMachineSettingsStore().trashPage', () => {
  const trashOk = {
    success: true,
    driveId: 'drive-1',
    pageTitle: 'My Machine',
    pageType: 'MACHINE',
    parentId: 'parent-1',
    isAIChatPage: false,
  };

  it('routes through the canonical pageService.trashPage with the descendant cascade enabled', async () => {
    // trashChildren: true is what gives the delete its cascade; the revision
    // bump, page version, and page-trash workflow triggers are pageService.
    // trashPage's own (separately tested) behavior — asserting this call IS
    // the fix for the raw pageRepository.trash bypass.
    mockTrashPage.mockResolvedValue(trashOk);
    await createDbMachineSettingsStore(USER).trashPage(MACHINE);
    expect(mockTrashPage).toHaveBeenCalledWith(
      MACHINE,
      USER,
      expect.objectContaining({ trashChildren: true }),
    );
  });

  it('broadcasts the trashed event (same payload shape as the page DELETE route) after a successful trash', async () => {
    mockTrashPage.mockResolvedValue(trashOk);
    await createDbMachineSettingsStore(USER).trashPage(MACHINE);
    expect(mockCreatePageEventPayload).toHaveBeenCalledWith('drive-1', MACHINE, 'trashed', {
      title: 'My Machine',
      parentId: 'parent-1',
    });
    expect(mockBroadcastPageEvent).toHaveBeenCalledTimes(1);
  });

  it('throws (and does not broadcast) when the canonical trash reports failure', async () => {
    // deleteMachine treats a trashPage throw as the non-recoverable first step
    // failing: the ref scrub and Sprite teardown never run.
    mockTrashPage.mockResolvedValue({ success: false, error: 'nope', status: 403 });
    await expect(createDbMachineSettingsStore(USER).trashPage(MACHINE)).rejects.toThrow('nope');
    expect(mockBroadcastPageEvent).not.toHaveBeenCalled();
  });

  it('soft-deletes only — never issues a hard delete (restore must keep working)', async () => {
    mockTrashPage.mockResolvedValue(trashOk);
    await createDbMachineSettingsStore(USER).trashPage(MACHINE);
    // The store performs no writes of its own besides the canonical trash call:
    // no raw update/delete that a restore couldn't undo.
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });
});

describe('createDbMachineRefScrub().scrub', () => {
  it('removes only the deleted machineId from a referencing AI_CHAT agent, via the canonical applyPageMutation', async () => {
    mockSelectWhere.mockResolvedValue([
      {
        id: 'agent-1',
        revision: 7,
        machineAccess: true,
        machines: [
          { kind: 'own' },
          { kind: 'existing', machineId: MACHINE },
          { kind: 'existing', machineId: 'machine-2' },
        ],
      },
    ]);

    await createDbMachineRefScrub(USER).scrub(MACHINE);

    expect(mockApplyPageMutation).toHaveBeenCalledTimes(1);
    expect(mockApplyPageMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: 'agent-1',
        operation: 'agent_config_update',
        updates: { machines: [{ kind: 'own' }, { kind: 'existing', machineId: 'machine-2' }] },
        updatedFields: ['machines'],
        expectedRevision: 7,
        context: expect.objectContaining({
          userId: USER,
          actorEmail: 'jono@x.test',
          changeGroupType: 'system',
          resourceType: 'agent',
        }),
      }),
    );
  });

  it('disables machineAccess when the deleted machine was the agent\'s ONLY ref (no silent own-machine fallback)', async () => {
    // resolveConfiguredMachines treats machineAccess=true + machines=[] as
    // "fall back to {kind:'own'}" — so an emptied list must flip access off,
    // or the agent silently switches to a different machine.
    mockSelectWhere.mockResolvedValue([
      { id: 'agent-1', revision: 3, machineAccess: true, machines: [{ kind: 'existing', machineId: MACHINE }] },
    ]);

    await createDbMachineRefScrub(USER).scrub(MACHINE);

    expect(mockApplyPageMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        updates: { machines: [], machineAccess: false },
        updatedFields: ['machines', 'machineAccess'],
      }),
    );
  });

  it('leaves machineAccess alone when other refs remain after the scrub', async () => {
    mockSelectWhere.mockResolvedValue([
      {
        id: 'agent-1',
        revision: 3,
        machineAccess: true,
        machines: [{ kind: 'own' }, { kind: 'existing', machineId: MACHINE }],
      },
    ]);

    await createDbMachineRefScrub(USER).scrub(MACHINE);

    expect(mockApplyPageMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        updates: { machines: [{ kind: 'own' }] },
        updatedFields: ['machines'],
      }),
    );
  });

  it('preserves malformed sibling entries byte-for-byte (removes ONLY the deleted ref)', async () => {
    const malformed = { kind: 'existing' }; // no machineId — fails isMachineRef
    mockSelectWhere.mockResolvedValue([
      { id: 'agent-1', revision: 1, machineAccess: true, machines: [malformed, { kind: 'existing', machineId: MACHINE }] },
    ]);

    await createDbMachineRefScrub(USER).scrub(MACHINE);

    expect(mockApplyPageMutation).toHaveBeenCalledWith(
      expect.objectContaining({ updates: { machines: [malformed] } }),
    );
  });

  it('keeps sweeping the remaining agents when one fails, then throws so the delete reports the scrub as failed', async () => {
    mockSelectWhere.mockResolvedValue([
      { id: 'agent-1', revision: 1, machineAccess: true, machines: [{ kind: 'existing', machineId: MACHINE }] },
      { id: 'agent-2', revision: 2, machineAccess: true, machines: [{ kind: 'existing', machineId: MACHINE }] },
    ]);
    mockApplyPageMutation
      .mockRejectedValueOnce(new Error('revision mismatch'))
      .mockResolvedValueOnce({});

    await expect(createDbMachineRefScrub(USER).scrub(MACHINE)).rejects.toThrow('1 agent config');
    expect(mockApplyPageMutation).toHaveBeenCalledTimes(2);
    expect(mockApplyPageMutation).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: 'agent-2' }));
  });

  it('also rewrites global_assistant_config.machines and clears machineAccess when the list empties', async () => {
    await createDbMachineRefScrub(USER).scrub(MACHINE);
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    // The single UPDATE must rewrite the list AND carry the machineAccess CASE
    // (both SET expressions read the OLD row, so they see the same list).
    const setArg = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(setArg).sort()).toEqual(['machineAccess', 'machines']);
    expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
  });

  it('does nothing agent-side when no AI_CHAT agent references the machine', async () => {
    await createDbMachineRefScrub(USER).scrub(MACHINE);
    expect(mockApplyPageMutation).not.toHaveBeenCalled();
    expect(mockGetActorInfo).not.toHaveBeenCalled();
  });
});

describe('createMachineSpriteTeardown().teardown', () => {
  it('kills branch Sprites before the machine\'s own Sprite and removes the session row', async () => {
    mockSelectWhere
      .mockResolvedValueOnce([]) // children of the root — none
      .mockResolvedValueOnce([{ sandboxId: 'sb-branch' }]); // root's branch rows

    await createMachineSpriteTeardown().teardown(MACHINE);

    expect(mockHostKill.mock.calls.map((c) => c[0])).toEqual([
      { machineId: 'sb-branch' },
      { machineId: `own-key-${MACHINE}` },
    ]);
    expect(mockSessionRemove).toHaveBeenCalledWith(`key-${MACHINE}`);
  });

  it('tears down nested Machine pages hidden by the cascade-trash (descendants first, root last)', async () => {
    mockSelectWhere
      .mockResolvedValueOnce([
        { id: 'child-doc', type: 'DOCUMENT' },
        { id: 'child-machine', type: 'MACHINE' },
      ]) // children of the root
      .mockResolvedValueOnce([]) // grandchildren — none
      .mockResolvedValueOnce([{ sandboxId: 'sb-child-branch' }]) // child machine's branches
      .mockResolvedValueOnce([]); // root's branches — none

    await createMachineSpriteTeardown().teardown(MACHINE);

    expect(mockHostKill.mock.calls.map((c) => c[0])).toEqual([
      { machineId: 'sb-child-branch' },
      { machineId: 'own-key-child-machine' },
      { machineId: `own-key-${MACHINE}` },
    ]);
  });

  it('still tears down the root when a descendant fails, then throws so the delete reports spriteTornDown=false', async () => {
    mockSelectWhere
      .mockResolvedValueOnce([{ id: 'child-machine', type: 'MACHINE' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]) // child branches
      .mockResolvedValueOnce([]); // root branches
    mockHostKill.mockImplementation(async ({ machineId }: { machineId: string }) => {
      if (machineId === 'own-key-child-machine') throw new Error('host down');
    });

    await expect(createMachineSpriteTeardown().teardown(MACHINE)).rejects.toThrow('1 machine(s)');
    // The root's own Sprite was still killed — one failure never strands the rest.
    expect(mockHostKill.mock.calls.map((c) => c[0])).toContainEqual({ machineId: `own-key-${MACHINE}` });
  });

  it('does nothing when neither branches nor a live session exist', async () => {
    mockSelectWhere
      .mockResolvedValueOnce([]) // no children
      .mockResolvedValueOnce([]); // no branches
    mockSessionFind.mockResolvedValue(null);

    await createMachineSpriteTeardown().teardown(MACHINE);
    expect(mockHostKill).not.toHaveBeenCalled();
  });
});
