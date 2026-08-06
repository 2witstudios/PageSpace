/**
 * Workspace layout store contract tests (fake-backed — see
 * `fake-workspace-layout-store.ts`; the same contract the DB-backed
 * implementation honors): rev monotonicity, the idempotent-retry no-bump,
 * per-workspace rev isolation, the dual-write blob leg riding only APPLIED
 * writes, and the op-memory first-write-wins semantics.
 */
import { describe, it, expect } from 'vitest';
import { createFakeWorkspaceLayoutStore } from './fake-workspace-layout-store';
import type { LayoutGridColumn } from '../../../agent-sessions/workspace-layout-verbs';
import type { PersistedWorkspaceState } from '../../../agent-sessions/contract';

const WORKSPACE_ID = 'ses-1';

const GRID_A: LayoutGridColumn[] = [
  {
    id: 'col-1',
    panes: [
      { id: 'pane-1', kind: 'chat', targetId: 'conv-1' },
      { id: 'pane-2', kind: null, targetId: null },
    ],
  },
];

const GRID_B: LayoutGridColumn[] = [
  { id: 'col-1', panes: [{ id: 'pane-1', kind: 'chat', targetId: 'conv-1' }] },
  { id: 'col-2', panes: [{ id: 'pane-3', kind: 'terminal', targetId: 'shell-1' }] },
];

const blobFor = (grid: LayoutGridColumn[]): PersistedWorkspaceState => ({
  id: WORKSPACE_ID,
  columns: grid.map((column) => ({
    id: column.id,
    panes: column.panes.map((pane) => ({
      id: pane.id,
      scope: pane.kind === null ? null : { kind: pane.kind, name: '', targetId: pane.targetId, agentPageId: null },
    })),
  })),
  activePaneId: grid[0].panes[0].id,
  pendingPickerPaneId: null,
});

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

  it('writes the dual-write blob leg only when the grid write applies', async () => {
    const store = createFakeWorkspaceLayoutStore();
    const blobA = blobFor(GRID_A);
    await store.replaceWorkspaceGrid({ workspaceId: WORKSPACE_ID, grid: GRID_A, workspaceState: blobA });
    expect(await store.getWorkspaceBlob(WORKSPACE_ID)).toEqual(blobA);

    // A retried (content-identical) write must not touch the blob either.
    const blobStale = { ...blobA, activePaneId: 'pane-2' };
    const retry = await store.replaceWorkspaceGrid({ workspaceId: WORKSPACE_ID, grid: GRID_A, workspaceState: blobStale });
    expect(retry.applied).toBe(false);
    expect(await store.getWorkspaceBlob(WORKSPACE_ID)).toEqual(blobA);
  });

  it('saveWorkspaceBlob writes the blob unconditionally (the legacy PUT leg)', async () => {
    const store = createFakeWorkspaceLayoutStore();
    const blob = blobFor(GRID_A);
    await store.saveWorkspaceBlob(WORKSPACE_ID, blob);
    expect(await store.getWorkspaceBlob(WORKSPACE_ID)).toEqual(blob);
    expect(await store.currentRev(WORKSPACE_ID)).toBe(0);
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
