/**
 * Unit tests for the Machine Settings runtime wiring — specifically the two
 * delete-path seams:
 *
 * - `createDbMachineSettingsStore().trashPage` must route through the CANONICAL
 *   `pageService.trashPage` (descendant cascade-trash, revision bump + page
 *   version, page-trash workflow triggers — all of which are that service's
 *   own tested behavior), not a raw `pageRepository.trash`, and must stay a
 *   SOFT delete so restore keeps working.
 * - `createDbMachineRefScrub().scrub` must remove the deleted machineId from
 *   referencing AI_CHAT agents' `machines` arrays (through the canonical
 *   `applyPageMutation`) and from `global_assistant_config.machines`.
 *
 * DB access and the canonical services are mocked; these tests verify THIS
 * module's routing and element-filtering logic.
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
      pages: { findFirst: vi.fn() },
      drives: { findFirst: vi.fn() },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values })),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', type: 'type', revision: 'revision', machines: 'machines', isTrashed: 'isTrashed' },
  drives: { id: 'id', ownerId: 'ownerId' },
}));
vi.mock('@pagespace/db/schema/integrations', () => ({
  globalAssistantConfig: { machines: 'machines' },
}));
vi.mock('@pagespace/db/schema/machine-branches', () => ({
  machineBranches: { machineId: 'machineId', sandboxId: 'sandboxId' },
}));
vi.mock('@pagespace/lib/services/sandbox/machine-session-manager', () => ({
  createDbMachineSessionStore: vi.fn(),
  deriveMachineSessionKey: vi.fn(),
  getSandboxSessionSecret: vi.fn(),
}));
vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: (...args: unknown[]) => mockBroadcastPageEvent(...args),
  createPageEventPayload: (...args: unknown[]) => mockCreatePageEventPayload(...args),
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserDeletePage: vi.fn(),
}));
vi.mock('@pagespace/lib/content/page-types.config', () => ({
  isMachinePage: vi.fn(),
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
  getMachineHostForBranches: vi.fn(),
}));
vi.mock('../machine-access-runtime', () => ({
  canViewMachine: vi.fn(),
  canEditMachine: vi.fn(),
}));

import { createDbMachineSettingsStore, createDbMachineRefScrub } from '../machine-settings-runtime';

const USER = 'user-1';
const MACHINE = 'machine-1';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActorInfo.mockResolvedValue({ actorEmail: 'jono@x.test', actorDisplayName: 'Jono' });
  mockSelectWhere.mockResolvedValue([]);
  mockUpdateWhere.mockResolvedValue(undefined);
  mockApplyPageMutation.mockResolvedValue({});
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
    // failing: the Sprite teardown and ref scrub never run.
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

  it('preserves malformed sibling entries byte-for-byte (removes ONLY the deleted ref)', async () => {
    const malformed = { kind: 'existing' }; // no machineId — fails isMachineRef
    mockSelectWhere.mockResolvedValue([
      { id: 'agent-1', revision: 1, machines: [malformed, { kind: 'existing', machineId: MACHINE }] },
    ]);

    await createDbMachineRefScrub(USER).scrub(MACHINE);

    expect(mockApplyPageMutation).toHaveBeenCalledWith(
      expect.objectContaining({ updates: { machines: [malformed] } }),
    );
  });

  it('keeps sweeping the remaining agents when one fails, then throws so the delete reports the scrub as failed', async () => {
    mockSelectWhere.mockResolvedValue([
      { id: 'agent-1', revision: 1, machines: [{ kind: 'existing', machineId: MACHINE }] },
      { id: 'agent-2', revision: 2, machines: [{ kind: 'existing', machineId: MACHINE }] },
    ]);
    mockApplyPageMutation
      .mockRejectedValueOnce(new Error('revision mismatch'))
      .mockResolvedValueOnce({});

    await expect(createDbMachineRefScrub(USER).scrub(MACHINE)).rejects.toThrow('1 agent config');
    expect(mockApplyPageMutation).toHaveBeenCalledTimes(2);
    expect(mockApplyPageMutation).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: 'agent-2' }));
  });

  it('also rewrites global_assistant_config.machines (same MachineRef shape as migration 0195)', async () => {
    await createDbMachineRefScrub(USER).scrub(MACHINE);
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
  });

  it('does nothing agent-side when no AI_CHAT agent references the machine', async () => {
    await createDbMachineRefScrub(USER).scrub(MACHINE);
    expect(mockApplyPageMutation).not.toHaveBeenCalled();
    expect(mockGetActorInfo).not.toHaveBeenCalled();
  });
});
