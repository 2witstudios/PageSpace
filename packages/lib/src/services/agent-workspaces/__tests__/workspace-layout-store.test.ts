/**
 * Workspace layout store contract tests (fake-backed — see
 * `fake-workspace-layout-store.ts`; the same contract the DB-backed
 * implementation honors): rev monotonicity, the idempotent-retry no-bump,
 * per-workspace rev isolation, and the op-memory first-write-wins semantics.
 */
import { describe, it, expect } from 'vitest';
import { createFakeWorkspaceLayoutStore } from './fake-workspace-layout-store';
import type { LayoutGridColumn } from '../../../agent-workspaces/workspace-layout-verbs';

const WORKSPACE_ID = 'ses-1';

// Fractions are CANONICAL null on an unsized grid — never absent. The store's
// content diff is a `JSON.stringify` comparison, where an undefined key simply
// vanishes from the string, so the projection type requires them (issue #2208).
const GRID_A: LayoutGridColumn[] = [
  {
    id: 'col-1',
    widthFraction: null,
    panes: [
      { id: 'pane-1', kind: 'chat', targetId: 'conv-1', heightFraction: null },
      { id: 'pane-2', kind: null, targetId: null, heightFraction: null },
    ],
  },
];

const GRID_B: LayoutGridColumn[] = [
  { id: 'col-1', widthFraction: null, panes: [{ id: 'pane-1', kind: 'chat', targetId: 'conv-1', heightFraction: null }] },
  { id: 'col-2', widthFraction: null, panes: [{ id: 'pane-3', kind: 'terminal', targetId: 'shell-1', heightFraction: null }] },
];

/** GRID_A, sized — same structure, different shares. */
const GRID_A_SIZED: LayoutGridColumn[] = [
  {
    id: 'col-1',
    widthFraction: null,
    panes: [
      { id: 'pane-1', kind: 'chat', targetId: 'conv-1', heightFraction: 0.75 },
      { id: 'pane-2', kind: null, targetId: null, heightFraction: 0.25 },
    ],
  },
];

describe('workspace-layout-store: rev counter', () => {
  it('starts at 0 for a workspace with no prior verbs', async () => {
    const store = createFakeWorkspaceLayoutStore();
    expect(await store.currentRev(WORKSPACE_ID)).toBe(0);
  });

  it('is monotonic per workspace and isolated between workspaces', async () => {
    const store = createFakeWorkspaceLayoutStore();
    expect((await store.replaceWorkspaceGrid({ workspaceId: 'ses-a', grid: GRID_A })).rev).toBe(1);
    expect((await store.replaceWorkspaceGrid({ workspaceId: 'ses-a', grid: GRID_B })).rev).toBe(2);
    expect((await store.replaceWorkspaceGrid({ workspaceId: 'ses-b', grid: GRID_A })).rev).toBe(1);
    expect(await store.currentRev('ses-a')).toBe(2);
    expect(await store.currentRev('ses-b')).toBe(1);
  });
});

describe('workspace-layout-store: replaceWorkspaceGrid', () => {
  it('replacing an empty grid with a new one bumps rev and applies', async () => {
    const store = createFakeWorkspaceLayoutStore();
    const result = await store.replaceWorkspaceGrid({ workspaceId: WORKSPACE_ID, grid: GRID_A });
    expect(result).toEqual({ rev: 1, applied: true });
    expect(await store.getWorkspaceGrid(WORKSPACE_ID)).toEqual(GRID_A);
  });

  it('replacing with the SAME grid (idempotent verb retry) does not bump rev and reports not applied', async () => {
    const store = createFakeWorkspaceLayoutStore();
    await store.replaceWorkspaceGrid({ workspaceId: WORKSPACE_ID, grid: GRID_A });
    const retry = await store.replaceWorkspaceGrid({ workspaceId: WORKSPACE_ID, grid: GRID_A });
    expect(retry).toEqual({ rev: 1, applied: false });
    expect(await store.currentRev(WORKSPACE_ID)).toBe(1);
  });

  it('replacing with a genuinely different grid bumps rev again', async () => {
    const store = createFakeWorkspaceLayoutStore();
    await store.replaceWorkspaceGrid({ workspaceId: WORKSPACE_ID, grid: GRID_A });
    const changed = await store.replaceWorkspaceGrid({ workspaceId: WORKSPACE_ID, grid: GRID_B });
    expect(changed).toEqual({ rev: 2, applied: true });
    expect(await store.getWorkspaceGrid(WORKSPACE_ID)).toEqual(GRID_B);
  });

  it('treats a SIZE-only change as a real change — a resize bumps rev like any other verb', async () => {
    const store = createFakeWorkspaceLayoutStore();
    await store.replaceWorkspaceGrid({ workspaceId: WORKSPACE_ID, grid: GRID_A });
    // Identical structure, different shares. Fractions are rows, so this is a
    // content change, not a view-state one.
    const resized = await store.replaceWorkspaceGrid({ workspaceId: WORKSPACE_ID, grid: GRID_A_SIZED });
    expect(resized).toEqual({ rev: 2, applied: true });
    expect(await store.getWorkspaceGrid(WORKSPACE_ID)).toEqual(GRID_A_SIZED);

    // And re-sending the same sizes is still an idempotent no-op — the whole
    // reason both sides quantize to one precision grid.
    const replay = await store.replaceWorkspaceGrid({ workspaceId: WORKSPACE_ID, grid: GRID_A_SIZED });
    expect(replay).toEqual({ rev: 2, applied: false });
  });

  it('reads MANY workspaces\' grids in one call, skipping the gridless', async () => {
    const store = createFakeWorkspaceLayoutStore();
    await store.replaceWorkspaceGrid({ workspaceId: WORKSPACE_ID, grid: GRID_A });
    await store.replaceWorkspaceGrid({ workspaceId: 'ses-2', grid: GRID_B });
    // The sessions-list GET's shape. A session with no rows has NO entry —
    // callers read that as `null`, never as an empty grid.
    const grids = await store.getWorkspaceGridsBulk([WORKSPACE_ID, 'ses-2', 'ses-never-opened']);
    expect([...grids.keys()].sort()).toEqual(['ses-1', 'ses-2']);
    expect(grids.get(WORKSPACE_ID)).toEqual(GRID_A);
    expect(grids.get('ses-2')).toEqual(GRID_B);
  });
});

describe('workspace-layout-store: op memory', () => {
  it('finds a recorded op and never overwrites it (first write wins)', async () => {
    const store = createFakeWorkspaceLayoutStore();
    expect(await store.findOp(WORKSPACE_ID, 'op-1')).toBeNull();
    await store.recordOp({ workspaceId: WORKSPACE_ID, opId: 'op-1', rev: 3, applied: true });
    expect(await store.findOp(WORKSPACE_ID, 'op-1')).toEqual({ rev: 3, applied: true });
    await store.recordOp({ workspaceId: WORKSPACE_ID, opId: 'op-1', rev: 9, applied: false });
    expect(await store.findOp(WORKSPACE_ID, 'op-1')).toEqual({ rev: 3, applied: true });
  });

  it('scopes op memory per workspace', async () => {
    const store = createFakeWorkspaceLayoutStore();
    await store.recordOp({ workspaceId: 'ses-a', opId: 'op-1', rev: 1, applied: true });
    expect(await store.findOp('ses-b', 'op-1')).toBeNull();
  });
});
