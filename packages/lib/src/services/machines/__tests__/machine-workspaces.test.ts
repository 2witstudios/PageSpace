import { describe, it, expect } from 'vitest';
import {
  deriveWorkspaceScope,
  isValidWorkspaceName,
  planWorkspacePayload,
  createWorkspace,
  updateWorkspace,
  removeWorkspace,
  listWorkspaces,
  type MachineWorkspacesDeps,
  type WorkspaceLayoutInput,
} from '../machine-workspaces';
import type { MachineWorkspaceStore, MachineWorkspaceRecord, NewMachineWorkspaceInput } from '../machine-workspaces-store';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const MACHINE_ID = 'machine-1';

const VALID_COLUMNS = { columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }] };

// Keyed by the COMPOUND (machineId, id) — never `id` alone. `sessionWorkspaceId`
// has no machineId in it, so two different machines legitimately mint the
// identical `id` for their own, unrelated sessions; a fake keyed by `id` alone
// would mask exactly the cross-machine collision bug the real store's
// compound primary key exists to prevent.
function rowKey(machineId: string, id: string): string {
  return `${machineId}::${id}`;
}

function makeStore(seed: MachineWorkspaceRecord[] = []) {
  const rows = new Map<string, MachineWorkspaceRecord>();
  for (const row of seed) rows.set(rowKey(row.machineId, row.id), row);

  const rowsForMachine = (machineId: string) =>
    [...rows.values()]
      .filter((row) => row.machineId === machineId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const store: MachineWorkspaceStore = {
    list: async (machineId) => rowsForMachine(machineId),

    findById: async (machineId, id) => rows.get(rowKey(machineId, id)) ?? null,

    insertIfAbsent: async (input: NewMachineWorkspaceInput) => {
      const key = rowKey(input.machineId, input.id);
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
      const key = rowKey(machineId, id);
      const row = rows.get(key);
      if (!row) return null;
      const next: MachineWorkspaceRecord = {
        ...row,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.layout !== undefined ? { layout: patch.layout } : {}),
        updatedAt: now,
      };
      rows.set(key, next);
      return next;
    },

    remove: async (machineId, id) => {
      return rows.delete(rowKey(machineId, id));
    },
  };

  return { store, rows };
}

function makeDeps(seed: MachineWorkspaceRecord[] = []) {
  const { store, rows } = makeStore(seed);
  const deps: MachineWorkspacesDeps = { store, now: () => NOW };
  return { deps, store, rows };
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

  // #2166 phase 9 — the client tags a pane's bound scope with a content kind
  // ('terminal' | 'chat'); this mirror type and its lenient runtime check must
  // tolerate it so a workspace layout carrying the tag round-trips through create/update.
  it('accepts a pane scope carrying the content kind — mirrors the client\'s tagged bound scope, lenient by design', () => {
    const layoutWithKind: WorkspaceLayoutInput = {
      columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: { name: 'claude-a1', kind: 'chat' } }] }],
    };

    const plan = planWorkspacePayload({ name: 'Workspace 1', layout: layoutWithKind });

    expect(plan).toEqual({ ok: true, name: 'Workspace 1', layout: layoutWithKind });
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

  // Regression: `updateWorkspace` already trims on rename — create (and
  // bootstrap seeding, which shares `planWorkspacePayload`) must persist the
  // same trimmed string for the same input, or the same logical name ends up
  // represented two different ways depending on which endpoint wrote it.
  it('trims a whitespace-padded name — matching updateWorkspace\'s rename behavior', async () => {
    const { deps } = makeDeps();
    const result = await createWorkspace({
      machineId: MACHINE_ID,
      ownerId: 'user-1',
      id: 'ws-1',
      name: '  Foo  ',
      scope: {},
      layout: VALID_COLUMNS,
      deps,
    });
    expect(result).toMatchObject({ ok: true, workspace: { name: 'Foo' } });
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

  it('two DIFFERENT machines minting the identical id (sessionWorkspaceId has no machineId in it) both succeed independently', async () => {
    const { deps, rows } = makeDeps();
    const sameId = 'sessionrepomainclaude-a1';

    const onMachineA = await createWorkspace({
      machineId: 'machine-a',
      ownerId: 'user-1',
      id: sameId,
      name: 'claude-a1 (machine A)',
      scope: { projectName: 'repo', branchName: 'main' },
      layout: VALID_COLUMNS,
      deps,
    });
    const onMachineB = await createWorkspace({
      machineId: 'machine-b',
      ownerId: 'user-1',
      id: sameId,
      name: 'claude-a1 (machine B)',
      scope: { projectName: 'repo', branchName: 'main' },
      layout: VALID_COLUMNS,
      deps,
    });

    // NEITHER is treated as a duplicate of the other — the primary key is
    // scoped by machineId, so the same client-minted id on two machines are
    // two distinct rows, not a collision.
    expect(onMachineA).toMatchObject({ ok: true, created: true });
    expect(onMachineB).toMatchObject({ ok: true, created: true });
    if (onMachineA.ok && onMachineB.ok) {
      expect(onMachineA.workspace.name).toBe('claude-a1 (machine A)');
      expect(onMachineB.workspace.name).toBe('claude-a1 (machine B)');
    }
    expect(rows.size).toBe(2);
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
    expect(rows.get(rowKey(MACHINE_ID, 'ws-1'))?.name).toBe('Workspace 1');
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
    expect(rows.has(rowKey(MACHINE_ID, 'ws-1'))).toBe(false);
  });

  it('returns not_found for an unknown workspace', async () => {
    const { deps } = makeDeps();
    const result = await removeWorkspace({ machineId: MACHINE_ID, workspaceId: 'missing', store: deps.store });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('listWorkspaces', () => {
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
});
