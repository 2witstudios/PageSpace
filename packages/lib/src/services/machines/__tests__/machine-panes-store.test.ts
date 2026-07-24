import { describe, it, expect } from 'vitest';
import { createFakeMachinePanesStore } from './fake-machine-panes-store';
import type { WorkspaceGridColumnInput } from '../machine-panes-store';

const MACHINE_ID = 'machine-1';
const WORKSPACE_ID = 'ws-1';

const GRID_A: WorkspaceGridColumnInput[] = [
  {
    id: 'col-1',
    panes: [
      { id: 'pane-1', scope: { name: 'shell', kind: 'terminal' } },
      { id: 'pane-2', scope: null },
    ],
  },
];

const GRID_B: WorkspaceGridColumnInput[] = [
  { id: 'col-1', panes: [{ id: 'pane-1', scope: { name: 'shell' } }] },
  { id: 'col-2', panes: [{ id: 'pane-3', scope: { name: 'agent-a', kind: 'chat' } }] },
];

describe('machine-panes-store: rev counter', () => {
  it('starts at 0 for a machine with no prior verbs', async () => {
    const store = createFakeMachinePanesStore();
    expect(await store.currentRev(MACHINE_ID)).toBe(0);
  });

  it('bumpRev is monotonic and independent per machine', async () => {
    const store = createFakeMachinePanesStore();
    expect(await store.bumpRev(MACHINE_ID)).toBe(1);
    expect(await store.bumpRev(MACHINE_ID)).toBe(2);
    expect(await store.bumpRev('machine-2')).toBe(1);
    expect(await store.currentRev(MACHINE_ID)).toBe(2);
  });
});

describe('machine-panes-store: replaceWorkspaceGrid', () => {
  it('replacing an empty grid with a new one bumps rev and applies', async () => {
    const store = createFakeMachinePanesStore();
    const result = await store.replaceWorkspaceGrid({ machineId: MACHINE_ID, workspaceId: WORKSPACE_ID, grid: GRID_A });
    expect(result).toEqual({ rev: 1, applied: true });
    expect(await store.getWorkspaceGrid(MACHINE_ID, WORKSPACE_ID)).toEqual(GRID_A);
  });

  it('replacing with the SAME grid (idempotent verb retry) does not bump rev and reports not applied', async () => {
    const store = createFakeMachinePanesStore();
    await store.replaceWorkspaceGrid({ machineId: MACHINE_ID, workspaceId: WORKSPACE_ID, grid: GRID_A });
    const retry = await store.replaceWorkspaceGrid({ machineId: MACHINE_ID, workspaceId: WORKSPACE_ID, grid: GRID_A });
    expect(retry).toEqual({ rev: 1, applied: false });
    expect(await store.currentRev(MACHINE_ID)).toBe(1);
  });

  it('replacing with a genuinely different grid bumps rev again', async () => {
    const store = createFakeMachinePanesStore();
    await store.replaceWorkspaceGrid({ machineId: MACHINE_ID, workspaceId: WORKSPACE_ID, grid: GRID_A });
    const changed = await store.replaceWorkspaceGrid({ machineId: MACHINE_ID, workspaceId: WORKSPACE_ID, grid: GRID_B });
    expect(changed).toEqual({ rev: 2, applied: true });
    expect(await store.getWorkspaceGrid(MACHINE_ID, WORKSPACE_ID)).toEqual(GRID_B);
  });

  it('replacing with an empty column array clears the grid (workspace reduced to zero panes) and bumps rev', async () => {
    const store = createFakeMachinePanesStore();
    await store.replaceWorkspaceGrid({ machineId: MACHINE_ID, workspaceId: WORKSPACE_ID, grid: GRID_A });
    const cleared = await store.replaceWorkspaceGrid({ machineId: MACHINE_ID, workspaceId: WORKSPACE_ID, grid: [] });
    expect(cleared).toEqual({ rev: 2, applied: true });
    expect(await store.getWorkspaceGrid(MACHINE_ID, WORKSPACE_ID)).toEqual([]);
  });

  it('grids for different workspaces on the same machine share one rev counter', async () => {
    const store = createFakeMachinePanesStore();
    const first = await store.replaceWorkspaceGrid({ machineId: MACHINE_ID, workspaceId: 'ws-a', grid: GRID_A });
    const second = await store.replaceWorkspaceGrid({ machineId: MACHINE_ID, workspaceId: 'ws-b', grid: GRID_B });
    expect(first.rev).toBe(1);
    expect(second.rev).toBe(2);
  });

  it('grids on different machines never share a rev counter', async () => {
    const store = createFakeMachinePanesStore();
    const a = await store.replaceWorkspaceGrid({ machineId: 'machine-a', workspaceId: WORKSPACE_ID, grid: GRID_A });
    const b = await store.replaceWorkspaceGrid({ machineId: 'machine-b', workspaceId: WORKSPACE_ID, grid: GRID_A });
    expect(a.rev).toBe(1);
    expect(b.rev).toBe(1);
  });
});

describe('machine-panes-store: reads', () => {
  it('getWorkspaceGrid returns [] for a workspace with no rows', async () => {
    const store = createFakeMachinePanesStore();
    expect(await store.getWorkspaceGrid(MACHINE_ID, 'unknown')).toEqual([]);
  });

  it('getMachineGrids returns every workspace grid on the machine, keyed by workspaceId', async () => {
    const store = createFakeMachinePanesStore();
    await store.replaceWorkspaceGrid({ machineId: MACHINE_ID, workspaceId: 'ws-a', grid: GRID_A });
    await store.replaceWorkspaceGrid({ machineId: MACHINE_ID, workspaceId: 'ws-b', grid: GRID_B });
    await store.replaceWorkspaceGrid({ machineId: 'other-machine', workspaceId: 'ws-c', grid: GRID_A });

    const grids = await store.getMachineGrids(MACHINE_ID);
    expect([...grids.keys()].sort()).toEqual(['ws-a', 'ws-b']);
    expect(grids.get('ws-a')).toEqual(GRID_A);
    expect(grids.get('ws-b')).toEqual(GRID_B);
  });

  it('preserves column and pane order as given, not insertion order of a differently-ordered write', async () => {
    const store = createFakeMachinePanesStore();
    await store.replaceWorkspaceGrid({ machineId: MACHINE_ID, workspaceId: WORKSPACE_ID, grid: GRID_B });
    const grid = await store.getWorkspaceGrid(MACHINE_ID, WORKSPACE_ID);
    expect(grid.map((c) => c.id)).toEqual(['col-1', 'col-2']);
  });
});
