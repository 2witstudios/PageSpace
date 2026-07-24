import { describe, it, expect } from 'vitest';
import { parseWorkspaceVerb, applyWorkspaceVerb, type ApplyWorkspaceVerbDeps } from '../workspace-verbs-runtime';
import type { MachineWorkspaceRecord, MachineWorkspaceStore, NewMachineWorkspaceInput } from '@pagespace/lib/services/machines/machine-workspaces-store';
import type { MachinePanesStore, WorkspaceGridColumnRecord } from '@pagespace/lib/services/machines/machine-panes-store';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const MACHINE_ID = 'machine-1';

describe('parseWorkspaceVerb', () => {
  it('rejects a non-object body', () => {
    expect(parseWorkspaceVerb(null)).toEqual({ ok: false, error: expect.any(String) });
  });

  it('rejects a body missing workspaceId', () => {
    expect(parseWorkspaceVerb({ type: 'rename-workspace', name: 'X' })).toMatchObject({ ok: false });
  });

  it('rejects an unknown verb type', () => {
    expect(parseWorkspaceVerb({ type: 'teleport-pane', workspaceId: 'ws-1' })).toMatchObject({ ok: false });
  });

  it('parses a well-formed create-workspace (born empty)', () => {
    const result = parseWorkspaceVerb({ type: 'create-workspace', workspaceId: 'ws-1', name: 'Workspace 1', scope: {}, firstPaneId: 'pane-1', session: null });
    expect(result).toEqual({
      ok: true,
      verb: { type: 'create-workspace', workspaceId: 'ws-1', name: 'Workspace 1', firstPaneId: 'pane-1', session: null, scope: {} },
    });
  });

  it('parses a well-formed create-workspace (born-bound) with scope', () => {
    const result = parseWorkspaceVerb({
      type: 'create-workspace',
      workspaceId: 'ws-1',
      name: 'claude-a1',
      scope: { projectName: 'repo', branchName: 'main' },
      firstPaneId: 'pane-1',
      session: { name: 'claude-a1', kind: 'chat' },
    });
    expect(result).toMatchObject({ ok: true, verb: { scope: { projectName: 'repo', branchName: 'main' }, session: { name: 'claude-a1', kind: 'chat' } } });
  });

  it('rejects create-workspace missing firstPaneId', () => {
    expect(parseWorkspaceVerb({ type: 'create-workspace', workspaceId: 'ws-1', name: 'X', session: null })).toMatchObject({ ok: false });
  });

  it('rejects create-workspace with a malformed session', () => {
    expect(
      parseWorkspaceVerb({ type: 'create-workspace', workspaceId: 'ws-1', name: 'X', firstPaneId: 'p', session: { kind: 'chat' } }),
    ).toMatchObject({ ok: false });
  });

  it('parses rename-workspace', () => {
    expect(parseWorkspaceVerb({ type: 'rename-workspace', workspaceId: 'ws-1', name: 'Renamed' })).toEqual({
      ok: true,
      verb: { type: 'rename-workspace', workspaceId: 'ws-1', name: 'Renamed' },
    });
  });

  it('rejects rename-workspace missing name', () => {
    expect(parseWorkspaceVerb({ type: 'rename-workspace', workspaceId: 'ws-1' })).toMatchObject({ ok: false });
  });

  it('parses remove-workspace', () => {
    expect(parseWorkspaceVerb({ type: 'remove-workspace', workspaceId: 'ws-1' })).toEqual({
      ok: true,
      verb: { type: 'remove-workspace', workspaceId: 'ws-1' },
    });
  });

  it('parses split-pane with direction and optional session', () => {
    const result = parseWorkspaceVerb({
      type: 'split-pane',
      workspaceId: 'ws-1',
      fromPaneId: 'pane-1',
      newPaneId: 'pane-2',
      direction: 'right',
      session: { name: 'claude-a1' },
    });
    expect(result).toEqual({
      ok: true,
      verb: { type: 'split-pane', workspaceId: 'ws-1', fromPaneId: 'pane-1', newPaneId: 'pane-2', direction: 'right', session: { name: 'claude-a1' } },
    });
  });

  it('rejects split-pane with an invalid direction', () => {
    expect(
      parseWorkspaceVerb({ type: 'split-pane', workspaceId: 'ws-1', fromPaneId: 'pane-1', newPaneId: 'pane-2', direction: 'sideways' }),
    ).toMatchObject({ ok: false });
  });

  it('parses bind-pane', () => {
    expect(parseWorkspaceVerb({ type: 'bind-pane', workspaceId: 'ws-1', paneId: 'pane-1', session: { name: 'shell' } })).toEqual({
      ok: true,
      verb: { type: 'bind-pane', workspaceId: 'ws-1', paneId: 'pane-1', session: { name: 'shell' } },
    });
  });

  it('rejects bind-pane missing session', () => {
    expect(parseWorkspaceVerb({ type: 'bind-pane', workspaceId: 'ws-1', paneId: 'pane-1' })).toMatchObject({ ok: false });
  });

  it('parses close-pane', () => {
    expect(parseWorkspaceVerb({ type: 'close-pane', workspaceId: 'ws-1', paneId: 'pane-1' })).toEqual({
      ok: true,
      verb: { type: 'close-pane', workspaceId: 'ws-1', paneId: 'pane-1' },
    });
  });

  it('parses add-pane', () => {
    expect(parseWorkspaceVerb({ type: 'add-pane', workspaceId: 'ws-1', newPaneId: 'pane-2', session: { name: 'claude-a1' } })).toEqual({
      ok: true,
      verb: { type: 'add-pane', workspaceId: 'ws-1', newPaneId: 'pane-2', session: { name: 'claude-a1' } },
    });
  });
});

// --- applyWorkspaceVerb: DI'd against in-memory fakes -----------------------

function makeWorkspaceStore(seed: MachineWorkspaceRecord[] = []): MachineWorkspaceStore {
  const rows = new Map<string, MachineWorkspaceRecord>();
  for (const row of seed) rows.set(`${row.machineId}::${row.id}`, row);

  return {
    list: async (machineId) => [...rows.values()].filter((r) => r.machineId === machineId),
    findById: async (machineId, id) => rows.get(`${machineId}::${id}`) ?? null,
    insertIfAbsent: async (input: NewMachineWorkspaceInput) => {
      const key = `${input.machineId}::${input.id}`;
      const existing = rows.get(key);
      if (existing) return { created: false, row: existing };
      const row: MachineWorkspaceRecord = {
        id: input.id,
        ownerId: input.ownerId,
        machineId: input.machineId,
        scope: input.scope,
        projectName: input.projectName,
        branchName: input.branchName,
        name: input.name,
        layout: input.layout,
        createdAt: input.now,
        updatedAt: input.now,
      };
      rows.set(key, row);
      return { created: true, row };
    },
    update: async (machineId, id, patch, now) => {
      const key = `${machineId}::${id}`;
      const row = rows.get(key);
      if (!row) return null;
      const next = { ...row, ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.layout !== undefined ? { layout: patch.layout } : {}), updatedAt: now };
      rows.set(key, next);
      return next;
    },
    remove: async (machineId, id) => rows.delete(`${machineId}::${id}`),
  };
}

function makePanesStore(): MachinePanesStore {
  const grids = new Map<string, WorkspaceGridColumnRecord[]>();
  const revs = new Map<string, number>();
  const bump = (machineId: string) => {
    const next = (revs.get(machineId) ?? 0) + 1;
    revs.set(machineId, next);
    return next;
  };
  return {
    getWorkspaceGrid: async (machineId, workspaceId) => grids.get(`${machineId}::${workspaceId}`) ?? [],
    getMachineGrids: async (machineId) => {
      const result = new Map<string, WorkspaceGridColumnRecord[]>();
      for (const [key, grid] of grids) {
        const [m, w] = key.split('::');
        if (m === machineId) result.set(w, grid);
      }
      return result;
    },
    replaceWorkspaceGrid: async ({ machineId, workspaceId, grid }) => {
      const key = `${machineId}::${workspaceId}`;
      const current = grids.get(key) ?? [];
      if (JSON.stringify(current) === JSON.stringify(grid)) return { rev: revs.get(machineId) ?? 0, applied: false };
      grids.set(key, grid);
      return { rev: bump(machineId), applied: true };
    },
    bumpRev: async (machineId) => bump(machineId),
    currentRev: async (machineId) => revs.get(machineId) ?? 0,
  };
}

function makeDeps(seed: MachineWorkspaceRecord[] = []): { deps: ApplyWorkspaceVerbDeps; workspaceStore: MachineWorkspaceStore; panesStore: MachinePanesStore } {
  const workspaceStore = makeWorkspaceStore(seed);
  const panesStore = makePanesStore();
  return {
    deps: { workspacesDeps: { store: workspaceStore, now: () => NOW }, panesStore, ownerId: 'user-1' },
    workspaceStore,
    panesStore,
  };
}

describe('applyWorkspaceVerb: create-workspace', () => {
  it('creates a new workspace, persists the grid, and bumps rev', async () => {
    const { deps } = makeDeps();
    const result = await applyWorkspaceVerb(MACHINE_ID, {
      type: 'create-workspace',
      workspaceId: 'ws-1',
      name: 'Workspace 1',
      scope: {},
      firstPaneId: 'pane-1',
      session: null,
    }, deps);

    expect(result).toMatchObject({ ok: true, applied: true, rev: 1, workspaceId: 'ws-1' });
    if (result.ok) {
      expect(result.workspace).toMatchObject({ id: 'ws-1', name: 'Workspace 1', columns: [{ id: 'pane-1', panes: [{ id: 'pane-1', scope: null }] }] });
    }
  });

  it('is idempotent: retrying the same id is a no-op (does not bump rev)', async () => {
    const { deps } = makeDeps();
    const verb = { type: 'create-workspace' as const, workspaceId: 'ws-1', name: 'Workspace 1', scope: {}, firstPaneId: 'pane-1', session: null };
    const first = await applyWorkspaceVerb(MACHINE_ID, verb, deps);
    const second = await applyWorkspaceVerb(MACHINE_ID, verb, deps);

    expect(first).toMatchObject({ applied: true, rev: 1 });
    expect(second).toMatchObject({ applied: false, rev: 1 });
  });
});

describe('applyWorkspaceVerb: rename-workspace', () => {
  it('renames and bumps rev even though the grid is untouched', async () => {
    const { deps } = makeDeps();
    await applyWorkspaceVerb(MACHINE_ID, { type: 'create-workspace', workspaceId: 'ws-1', name: 'Workspace 1', scope: {}, firstPaneId: 'pane-1', session: null }, deps);

    const result = await applyWorkspaceVerb(MACHINE_ID, { type: 'rename-workspace', workspaceId: 'ws-1', name: 'Renamed' }, deps);
    expect(result).toMatchObject({ ok: true, applied: true, rev: 2 });
    if (result.ok) expect(result.workspace?.name).toBe('Renamed');
  });

  it('an unknown workspace id is a no-op', async () => {
    const { deps } = makeDeps();
    const result = await applyWorkspaceVerb(MACHINE_ID, { type: 'rename-workspace', workspaceId: 'missing', name: 'X' }, deps);
    expect(result).toMatchObject({ ok: true, applied: false, workspace: null });
  });
});

describe('applyWorkspaceVerb: split-pane / bind-pane / close-pane / add-pane', () => {
  async function seeded() {
    const ctx = makeDeps();
    await applyWorkspaceVerb(MACHINE_ID, { type: 'create-workspace', workspaceId: 'ws-1', name: 'Workspace 1', scope: {}, firstPaneId: 'pane-1', session: null }, ctx.deps);
    return ctx;
  }

  it('split-pane persists the new grid and bumps rev', async () => {
    const { deps } = await seeded();
    const result = await applyWorkspaceVerb(MACHINE_ID, { type: 'split-pane', workspaceId: 'ws-1', fromPaneId: 'pane-1', newPaneId: 'pane-2', direction: 'right' }, deps);
    expect(result).toMatchObject({ ok: true, applied: true, rev: 2 });
    if (result.ok) expect(result.workspace?.columns.map((c) => c.id)).toEqual(['pane-1', 'pane-2']);
  });

  it('bind-pane persists the bound session', async () => {
    const { deps } = await seeded();
    const result = await applyWorkspaceVerb(MACHINE_ID, { type: 'bind-pane', workspaceId: 'ws-1', paneId: 'pane-1', session: { name: 'shell' } }, deps);
    expect(result).toMatchObject({ ok: true, applied: true, rev: 2 });
    if (result.ok) expect(result.workspace?.columns[0].panes[0].scope).toEqual({ name: 'shell' });
  });

  it('re-binding to the SAME session is a genuine no-op (content diff catches it even though the reducer re-applies)', async () => {
    const { deps } = await seeded();
    const verb = { type: 'bind-pane' as const, workspaceId: 'ws-1', paneId: 'pane-1', session: { name: 'shell' } };
    await applyWorkspaceVerb(MACHINE_ID, verb, deps);
    const result = await applyWorkspaceVerb(MACHINE_ID, verb, deps);
    expect(result).toMatchObject({ ok: true, applied: false, rev: 2 });
  });

  it('close-pane on the LAST pane removes the workspace row and bumps rev', async () => {
    const { deps, workspaceStore } = await seeded();
    const result = await applyWorkspaceVerb(MACHINE_ID, { type: 'close-pane', workspaceId: 'ws-1', paneId: 'pane-1' }, deps);
    expect(result).toMatchObject({ ok: true, applied: true, rev: 2, workspace: null });
    expect(await workspaceStore.findById(MACHINE_ID, 'ws-1')).toBeNull();
  });

  it('add-pane fills the existing empty pane', async () => {
    const { deps } = await seeded();
    const result = await applyWorkspaceVerb(MACHINE_ID, { type: 'add-pane', workspaceId: 'ws-1', newPaneId: 'pane-unused', session: { name: 'claude-a1' } }, deps);
    expect(result).toMatchObject({ ok: true, applied: true });
    if (result.ok) expect(result.workspace?.columns[0].panes).toEqual([{ id: 'pane-1', scope: { name: 'claude-a1' } }]);
  });

  it('an unknown workspace id is a no-op for every grid-touching verb', async () => {
    const { deps } = makeDeps();
    const result = await applyWorkspaceVerb(MACHINE_ID, { type: 'close-pane', workspaceId: 'missing', paneId: 'pane-1' }, deps);
    expect(result).toMatchObject({ ok: true, applied: false, workspace: null });
  });
});

describe('applyWorkspaceVerb: remove-workspace', () => {
  it('removes an existing workspace and bumps rev', async () => {
    const { deps, workspaceStore } = makeDeps();
    await applyWorkspaceVerb(MACHINE_ID, { type: 'create-workspace', workspaceId: 'ws-1', name: 'Workspace 1', scope: {}, firstPaneId: 'pane-1', session: null }, deps);
    const result = await applyWorkspaceVerb(MACHINE_ID, { type: 'remove-workspace', workspaceId: 'ws-1' }, deps);
    expect(result).toMatchObject({ ok: true, applied: true, rev: 2, workspace: null });
    expect(await workspaceStore.findById(MACHINE_ID, 'ws-1')).toBeNull();
  });
});
