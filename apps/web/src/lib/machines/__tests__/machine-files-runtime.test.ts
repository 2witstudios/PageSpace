/**
 * Unit tests for the root-or-branch dispatcher `resolveMachineFilesHandle`.
 *
 * Branch scope must delegate to `resolveBranchMachineHandle` with identical
 * behavior (unchanged `not_found`/`vanished` reasons); root scope resolves
 * through `resolveRootMachineHandle` and collapses a `null` handle (no live
 * session — no tracking row exists to say why) into the coarser `not_started`
 * reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResolveRootMachineHandle, mockGetMachineHostForBranches, mockFindByName, mockAttach } = vi.hoisted(
  () => ({
    mockResolveRootMachineHandle: vi.fn(),
    mockGetMachineHostForBranches: vi.fn(),
    mockFindByName: vi.fn(),
    mockAttach: vi.fn(),
  }),
);

vi.mock('../machine-branches-runtime', () => ({
  resolveRootMachineHandle: (...args: unknown[]) => mockResolveRootMachineHandle(...args),
  getMachineHostForBranches: (...args: unknown[]) => mockGetMachineHostForBranches(...args),
}));
vi.mock('../machine-access-runtime', () => ({
  canViewMachine: vi.fn(),
  canEditMachine: vi.fn(),
}));
vi.mock('@pagespace/lib/services/machines/machine-branches-store', () => ({
  createDbMachineBranchStore: vi.fn(async () => ({
    findByName: (...args: unknown[]) => mockFindByName(...args),
  })),
}));

import { resolveMachineFilesHandle, resolveBranchMachineHandle } from '../machine-files-runtime';

const MACHINE = 'machine-1';
const HANDLE = { machineId: 'sbx-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMachineHostForBranches.mockResolvedValue({ attach: (...args: unknown[]) => mockAttach(...args) });
});

describe('resolveMachineFilesHandle — root scope', () => {
  it('resolves ok with the live handle when the root Machine has a session', async () => {
    mockResolveRootMachineHandle.mockResolvedValue(HANDLE);

    const result = await resolveMachineFilesHandle({ scope: 'root', machineId: MACHINE });

    expect(mockResolveRootMachineHandle).toHaveBeenCalledWith(MACHINE);
    expect(result).toEqual({ ok: true, handle: HANDLE });
  });

  it('maps a null handle to not_started (no tracking row to say never-started vs gone)', async () => {
    mockResolveRootMachineHandle.mockResolvedValue(null);

    const result = await resolveMachineFilesHandle({ scope: 'root', machineId: MACHINE });

    expect(result).toEqual({ ok: false, reason: 'not_started' });
  });
});

describe('resolveMachineFilesHandle — branch scope', () => {
  const scope = { scope: 'branch' as const, machineId: MACHINE, projectName: 'p1', branchName: 'b1' };

  it('delegates to resolveBranchMachineHandle and returns not_found when no tracking row exists', async () => {
    mockFindByName.mockResolvedValue(undefined);

    const result = await resolveMachineFilesHandle(scope);

    expect(mockFindByName).toHaveBeenCalledWith(MACHINE, 'p1', 'b1');
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(mockResolveRootMachineHandle).not.toHaveBeenCalled();
  });

  it('delegates and returns vanished when the tracking row exists but the Sprite is gone', async () => {
    mockFindByName.mockResolvedValue({ sandboxId: 'sbx-2' });
    mockAttach.mockResolvedValue(null);

    const result = await resolveMachineFilesHandle(scope);

    expect(mockAttach).toHaveBeenCalledWith({ machineId: 'sbx-2' });
    expect(result).toEqual({ ok: false, reason: 'vanished' });
  });

  it('delegates and returns ok with the reconnected handle when the row and Sprite both exist', async () => {
    mockFindByName.mockResolvedValue({ sandboxId: 'sbx-2' });
    mockAttach.mockResolvedValue(HANDLE);

    const result = await resolveMachineFilesHandle(scope);

    expect(result).toEqual({ ok: true, handle: HANDLE });
  });

  it('produces the exact same result as calling resolveBranchMachineHandle directly', async () => {
    mockFindByName.mockResolvedValue({ sandboxId: 'sbx-2' });
    mockAttach.mockResolvedValue(HANDLE);

    const dispatched = await resolveMachineFilesHandle(scope);
    const direct = await resolveBranchMachineHandle(scope);

    expect(dispatched).toEqual(direct);
  });
});
