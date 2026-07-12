import { describe, test, expect, vi } from 'vitest';
import { listMachinesInDrive, type MachineListDeps, type MachinePageSummary } from '../machine-list';

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
