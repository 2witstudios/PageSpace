import { describe, it, expect } from 'vitest';
import {
  deriveWorkspaceScope,
  isValidWorkspaceName,
  planWorkspacePayload,
  createWorkspace,
  updateWorkspace,
  removeWorkspace,
  listWorkspaces,
  isBootstrapped,
  bootstrapWorkspaces,
  type MachineWorkspacesDeps,
} from '../machine-workspaces';
import type { MachineWorkspaceStore, MachineWorkspaceRecord, NewMachineWorkspaceInput } from '../machine-workspaces-store';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const MACHINE_ID = 'machine-1';

const VALID_COLUMNS = { columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }] };

function makeStore(seed: MachineWorkspaceRecord[] = []) {
  const rows = new Map<string, MachineWorkspaceRecord>();
  for (const row of seed) rows.set(row.id, row);
  const bootstrapped = new Set<string>();

  const store: MachineWorkspaceStore = {
    list: async (machineId) =>
      [...rows.values()]
        .filter((row) => row.machineId === machineId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),

    findById: async (machineId, id) => {
      const row = rows.get(id);
      return row && row.machineId === machineId ? row : null;
    },

    insertIfAbsent: async (input: NewMachineWorkspaceInput) => {
      const existing = rows.get(input.id);
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
      rows.set(input.id, row);
      return { created: true, row };
    },

    update: async (machineId, id, patch, now) => {
      const row = rows.get(id);
      if (!row || row.machineId !== machineId) return null;
      const next: MachineWorkspaceRecord = {
        ...row,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.layout !== undefined ? { layout: patch.layout } : {}),
        updatedAt: now,
      };
      rows.set(id, next);
      return next;
    },

    remove: async (machineId, id) => {
      const row = rows.get(id);
      if (!row || row.machineId !== machineId) return false;
      rows.delete(id);
      return true;
    },

    isBootstrapped: async (machineId) => bootstrapped.has(machineId),

    bootstrapSeed: async ({ machineId, workspaces }) => {
      // Mirrors the real store's transaction: claim first, and only seed rows
      // if THIS call actually won the claim.
      if (bootstrapped.has(machineId)) {
        return {
          claimed: false,
          workspaces: [...rows.values()]
            .filter((row) => row.machineId === machineId)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
        };
      }
      bootstrapped.add(machineId);
      for (const workspace of workspaces) {
        if (!rows.has(workspace.id)) {
          rows.set(workspace.id, {
            id: workspace.id,
            ownerId: workspace.ownerId,
            machineId: workspace.machineId,
            scope: workspace.scope,
            projectName: workspace.projectName,
            branchName: workspace.branchName,
            name: workspace.name,
            layout: workspace.layout,
            createdAt: workspace.now,
            updatedAt: workspace.now,
          });
        }
      }
      return {
        claimed: true,
        workspaces: [...rows.values()]
          .filter((row) => row.machineId === machineId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      };
    },
  };

  return { store, rows, bootstrapped };
}

function makeDeps(seed: MachineWorkspaceRecord[] = []) {
  const { store, rows, bootstrapped } = makeStore(seed);
  const deps: MachineWorkspacesDeps = { store, now: () => NOW };
  return { deps, store, rows, bootstrapped };
}

describe('deriveWorkspaceScope', () => {
  it('is "machine" with neither projectName nor branchName', () => {
    expect(deriveWorkspaceScope({})).toBe('machine');
  });

  it('is "project" with only projectName', () => {
    expect(deriveWorkspaceScope({ projectName: 'repo' })).toBe('project');
  });

  it('is "branch" whenever branchName is set (project always implied)', () => {
    expect(deriveWorkspaceScope({ projectName: 'repo', branchName: 'feat' })).toBe('branch');
  });
});

describe('isValidWorkspaceName / planWorkspacePayload', () => {
  it('rejects empty or whitespace-only names', () => {
    expect(isValidWorkspaceName('')).toBe(false);
    expect(isValidWorkspaceName('   ')).toBe(false);
    expect(planWorkspacePayload({ name: '', layout: VALID_COLUMNS })).toEqual({ ok: false, reason: 'invalid_name' });
  });

  it('rejects a layout with no columns, or a column with no panes', () => {
    expect(planWorkspacePayload({ name: 'Workspace 1', layout: { columns: [] } })).toEqual({
      ok: false,
      reason: 'invalid_columns',
    });
    expect(
      planWorkspacePayload({ name: 'Workspace 1', layout: { columns: [{ id: 'c1', panes: [] }] } }),
    ).toEqual({ ok: false, reason: 'invalid_columns' });
  });

  it('accepts a well-shaped payload', () => {
    const plan = planWorkspacePayload({ name: 'Workspace 1', layout: VALID_COLUMNS });
    expect(plan).toEqual({ ok: true, name: 'Workspace 1', layout: VALID_COLUMNS });
  });
});

describe('createWorkspace', () => {
  it('creates a new row and derives the scope discriminant', async () => {
    const { deps } = makeDeps();
    const result = await createWorkspace({
      machineId: MACHINE_ID,
      ownerId: 'user-1',
      id: 'ws-1',
      name: 'Workspace 1',
      scope: { projectName: 'repo', branchName: 'feat' },
      layout: VALID_COLUMNS,
      deps,
    });
    expect(result).toMatchObject({ ok: true, created: true });
    if (result.ok) {
      expect(result.workspace.scope).toBe('branch');
      expect(result.workspace.projectName).toBe('repo');
      expect(result.workspace.branchName).toBe('feat');
    }
  });

  it('rejects an invalid name/columns payload before touching the store', async () => {
    const { deps, rows } = makeDeps();
    const result = await createWorkspace({
      machineId: MACHINE_ID,
      ownerId: 'user-1',
      id: 'ws-1',
      name: '   ',
      scope: {},
      layout: VALID_COLUMNS,
      deps,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_name' });
    expect(rows.size).toBe(0);
  });

  it('is idempotent-by-id: two racing creates for the SAME id both succeed, one wins', async () => {
    const { deps } = makeDeps();
    const params = {
      machineId: MACHINE_ID,
      ownerId: 'user-1',
      id: 'sessionrepoclaude-a1',
      name: 'claude-a1',
      scope: { projectName: 'repo' },
      layout: VALID_COLUMNS,
      deps,
    };
    const first = await createWorkspace(params);
    const second = await createWorkspace({ ...params, name: 'a different name the second caller tried to use' });

    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: false });
    // The loser gets the WINNER's row back, not its own payload.
    if (first.ok && second.ok) {
      expect(second.workspace).toEqual(first.workspace);
      expect(second.workspace.name).toBe('claude-a1');
    }
  });
});

describe('updateWorkspace', () => {
  const seedRow: MachineWorkspaceRecord = {
    id: 'ws-1',
    ownerId: 'user-1',
    machineId: MACHINE_ID,
    scope: 'machine',
    projectName: null,
    branchName: null,
    name: 'Workspace 1',
    layout: VALID_COLUMNS,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('renames a workspace', async () => {
    const { deps } = makeDeps([seedRow]);
    const result = await updateWorkspace({ machineId: MACHINE_ID, workspaceId: 'ws-1', name: 'Renamed', deps });
    expect(result).toMatchObject({ ok: true, workspace: { name: 'Renamed' } });
  });

  it('updates the layout independently of the name', async () => {
    const { deps } = makeDeps([seedRow]);
    const newLayout = { columns: [{ id: 'col-2', panes: [{ id: 'pane-2', scope: null }] }] };
    const result = await updateWorkspace({ machineId: MACHINE_ID, workspaceId: 'ws-1', layout: newLayout, deps });
    expect(result).toMatchObject({ ok: true, workspace: { name: 'Workspace 1', layout: newLayout } });
  });

  it('rejects an invalid name without touching the row', async () => {
    const { deps, rows } = makeDeps([seedRow]);
    const result = await updateWorkspace({ machineId: MACHINE_ID, workspaceId: 'ws-1', name: '   ', deps });
    expect(result).toEqual({ ok: false, reason: 'invalid_name' });
    expect(rows.get('ws-1')?.name).toBe('Workspace 1');
  });

  it('returns not_found for an unknown workspace', async () => {
    const { deps } = makeDeps();
    const result = await updateWorkspace({ machineId: MACHINE_ID, workspaceId: 'missing', name: 'X', deps });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('removeWorkspace', () => {
  it('removes an existing workspace', async () => {
    const seedRow: MachineWorkspaceRecord = {
      id: 'ws-1',
      ownerId: 'user-1',
      machineId: MACHINE_ID,
      scope: 'machine',
      projectName: null,
      branchName: null,
      name: 'Workspace 1',
      layout: VALID_COLUMNS,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { deps, rows } = makeDeps([seedRow]);
    const result = await removeWorkspace({ machineId: MACHINE_ID, workspaceId: 'ws-1', store: deps.store });
    expect(result).toEqual({ ok: true });
    expect(rows.has('ws-1')).toBe(false);
  });

  it('returns not_found for an unknown workspace', async () => {
    const { deps } = makeDeps();
    const result = await removeWorkspace({ machineId: MACHINE_ID, workspaceId: 'missing', store: deps.store });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('listWorkspaces / isBootstrapped', () => {
  it('filters by machineId only', async () => {
    const { deps } = makeDeps([
      {
        id: 'ws-1',
        ownerId: 'user-1',
        machineId: MACHINE_ID,
        scope: 'machine',
        projectName: null,
        branchName: null,
        name: 'Workspace 1',
        layout: VALID_COLUMNS,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'ws-2',
        ownerId: 'user-1',
        machineId: 'other-machine',
        scope: 'machine',
        projectName: null,
        branchName: null,
        name: 'Workspace 1',
        layout: VALID_COLUMNS,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const result = await listWorkspaces({ machineId: MACHINE_ID, store: deps.store });
    expect(result.map((r) => r.id)).toEqual(['ws-1']);
  });

  it('is false until a machine has been bootstrapped', async () => {
    const { deps } = makeDeps();
    expect(await isBootstrapped({ machineId: MACHINE_ID, store: deps.store })).toBe(false);
  });
});

describe('bootstrapWorkspaces', () => {
  const input = (id: string, name: string) => ({ id, name, scope: {}, layout: VALID_COLUMNS });

  it('claims and seeds on the FIRST call for a machine', async () => {
    const { deps } = makeDeps();
    const result = await bootstrapWorkspaces({
      machineId: MACHINE_ID,
      ownerId: 'user-1',
      userId: 'user-1',
      workspaces: [input('ws-1', 'Workspace 1'), input('ws-2', 'Workspace 2')],
      deps,
    });
    expect(result).toMatchObject({ ok: true, claimed: true });
    if (result.ok) expect(result.workspaces.map((w) => w.id)).toEqual(['ws-1', 'ws-2']);
  });

  it('a SECOND call for the same machine loses the claim and gets the current list back, unseeded', async () => {
    const { deps } = makeDeps();
    const first = await bootstrapWorkspaces({
      machineId: MACHINE_ID,
      ownerId: 'user-1',
      userId: 'user-1',
      workspaces: [input('ws-1', "winner's workspace")],
      deps,
    });
    const second = await bootstrapWorkspaces({
      machineId: MACHINE_ID,
      ownerId: 'user-2',
      userId: 'user-2',
      workspaces: [input('ws-2', "loser's workspace — must NOT be seeded")],
      deps,
    });

    expect(first).toMatchObject({ ok: true, claimed: true });
    expect(second).toMatchObject({ ok: true, claimed: false });
    if (second.ok) {
      // The loser gets back exactly the winner's list — its own payload never landed.
      expect(second.workspaces.map((w) => w.id)).toEqual(['ws-1']);
    }
  });

  it('rejects a malformed entry before claiming — a bad payload must not consume the claim', async () => {
    const { deps, bootstrapped } = makeDeps();
    const result = await bootstrapWorkspaces({
      machineId: MACHINE_ID,
      ownerId: 'user-1',
      userId: 'user-1',
      workspaces: [input('ws-1', '   ')],
      deps,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_name' });
    expect(bootstrapped.has(MACHINE_ID)).toBe(false);
  });
});
