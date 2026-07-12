import { describe, test, expect, vi } from 'vitest';
import {
  listMachinesInDrive,
  listMachinesAcrossDrives,
  type MachineListDeps,
  type MachinePageSummary,
  type GlobalMachineListDeps,
  type DriveSummary,
} from '../machine-list';

const machine = (id: string, title = id): MachinePageSummary => ({
  id,
  title,
  updatedAt: '2026-07-11T00:00:00.000Z',
});

function buildDeps(
  pagesInDrive: MachinePageSummary[],
  viewable: (pageId: string) => boolean,
): MachineListDeps {
  return {
    findMachinePagesInDrive: vi.fn(async () => pagesInDrive),
    canUserViewPage: vi.fn(async (_userId: string, pageId: string) => viewable(pageId)),
  };
}

describe('listMachinesInDrive', () => {
  test('returns the drive\'s machines in scan order', async () => {
    const deps = buildDeps([machine('m-1', 'alpha'), machine('m-2', 'beta')], () => true);

    const result = await listMachinesInDrive(deps, 'user-1', 'drive-1');

    expect(result.map((m) => m.id)).toEqual(['m-1', 'm-2']);
    expect(deps.findMachinePagesInDrive).toHaveBeenCalledWith('drive-1');
  });

  test('withholds a machine the actor cannot view', async () => {
    const deps = buildDeps(
      [machine('m-1'), machine('m-secret'), machine('m-3')],
      (pageId) => pageId !== 'm-secret',
    );

    const result = await listMachinesInDrive(deps, 'user-1', 'drive-1');

    expect(result.map((m) => m.id)).toEqual(['m-1', 'm-3']);
  });

  test('checks visibility against the acting user', async () => {
    const deps = buildDeps([machine('m-1')], () => true);

    await listMachinesInDrive(deps, 'user-42', 'drive-1');

    expect(deps.canUserViewPage).toHaveBeenCalledWith('user-42', 'm-1');
  });

  test('a drive with no machines is an empty list, not an error', async () => {
    const deps = buildDeps([], () => true);

    expect(await listMachinesInDrive(deps, 'user-1', 'drive-1')).toEqual([]);
  });

  test('a drive whose every machine is withheld is an empty list', async () => {
    const deps = buildDeps([machine('m-1'), machine('m-2')], () => false);

    expect(await listMachinesInDrive(deps, 'user-1', 'drive-1')).toEqual([]);
  });
});

function buildGlobalDeps(
  drives: DriveSummary[],
  pagesByDrive: Record<string, MachinePageSummary[]>,
  viewable: (pageId: string) => boolean,
): GlobalMachineListDeps {
  return {
    findAccessibleDrives: vi.fn(async () => drives),
    findMachinePagesInDrive: vi.fn(async (driveId: string) => pagesByDrive[driveId] ?? []),
    canUserViewPage: vi.fn(async (_userId: string, pageId: string) => viewable(pageId)),
  };
}

describe('listMachinesAcrossDrives', () => {
  test('groups machines by the drives the actor can access', async () => {
    const deps = buildGlobalDeps(
      [
        { id: 'drive-1', name: 'Alpha' },
        { id: 'drive-2', name: 'Beta' },
      ],
      {
        'drive-1': [machine('m-1'), machine('m-2')],
        'drive-2': [machine('m-3')],
      },
      () => true,
    );

    const result = await listMachinesAcrossDrives(deps, 'user-1');

    expect(result).toEqual([
      { driveId: 'drive-1', driveName: 'Alpha', machines: [machine('m-1'), machine('m-2')] },
      { driveId: 'drive-2', driveName: 'Beta', machines: [machine('m-3')] },
    ]);
  });

  test('drops a drive whose every machine is withheld from this actor', async () => {
    // Rather than a page-level grant leaking the drive itself via an empty
    // group header — the same "structure the Machine page withholds" property
    // the per-drive list already protects.
    const deps = buildGlobalDeps(
      [
        { id: 'drive-1', name: 'Alpha' },
        { id: 'drive-2', name: 'Secret' },
      ],
      {
        'drive-1': [machine('m-1')],
        'drive-2': [machine('m-secret')],
      },
      (pageId) => pageId !== 'm-secret',
    );

    const result = await listMachinesAcrossDrives(deps, 'user-1');

    expect(result.map((g) => g.driveId)).toEqual(['drive-1']);
  });

  test('a drive with no Machine pages at all is dropped, not returned empty', async () => {
    const deps = buildGlobalDeps(
      [
        { id: 'drive-1', name: 'Alpha' },
        { id: 'drive-2', name: 'Empty' },
      ],
      { 'drive-1': [machine('m-1')] },
      () => true,
    );

    const result = await listMachinesAcrossDrives(deps, 'user-1');

    expect(result.map((g) => g.driveId)).toEqual(['drive-1']);
  });

  test('an actor with no accessible drives sees an empty list, not an error', async () => {
    const deps = buildGlobalDeps([], {}, () => true);

    expect(await listMachinesAcrossDrives(deps, 'user-1')).toEqual([]);
  });

  test('checks visibility against the acting user for every drive', async () => {
    const deps = buildGlobalDeps(
      [{ id: 'drive-1', name: 'Alpha' }],
      { 'drive-1': [machine('m-1')] },
      () => true,
    );

    await listMachinesAcrossDrives(deps, 'user-42');

    expect(deps.canUserViewPage).toHaveBeenCalledWith('user-42', 'm-1');
  });
});
