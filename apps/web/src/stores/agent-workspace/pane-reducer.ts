/**
 * The pane grid's pure layout model — ported from the machine workspace
 * reducer (`stores/machine-workspace/workspace-reducer.ts`, deleted in the
 * phase-8 teardown) with its transitions unchanged and its topology removed.
 *
 * **The layout is deliberately NOT a recursive split tree.** It is a horizontal
 * row of columns, each an independent vertical stack of panes: `splitRight`
 * adds a column, `splitDown` stacks within one. Two levels, no nesting. A
 * general tree buys arbitrary layouts nobody asks a terminal grid for, and
 * costs a rebalancing problem on every close.
 *
 * **What changed in the port, and why.** The old model hung a grid off a
 * Machine and let one machine own several named workspaces, each pinned to a
 * project/branch checkout (`MachineNodeScope`, `OpenTerminalScope`,
 * `projectName`/`branchName`). Git is no longer the information architecture
 * and a sandbox now belongs to a conversation-session, so:
 *
 *  - the workspace unit is the CONVERSATION — one grid per conversation, keyed
 *    by its id. The sidebar's leaves are conversations, which is exactly what
 *    the old sidebar's workspace leaves were;
 *  - every scope tuple is gone. A pane stores a {@link PaneScope} — what it
 *    shows and the id it shows it for — and nothing about where a checkout is;
 *  - server-synced layouts (`useMachineWorkspaceSync`, the `Server*DTO` types,
 *    `mergeServerWorkspaces`) are NOT ported. Layout is local and persisted.
 *
 * Every transition no-ops on an id it cannot resolve, so a stale click racing a
 * close is never an error.
 */

import type { PaneScope } from '@pagespace/lib/agent-sessions/contract';

export interface PaneState {
  id: string;
  /** `null` = unbound: the pane renders the picker. */
  scope: PaneScope | null;
  /**
   * Typed into the pane's agent once it is ready, then cleared — a pane that
   * re-mounts (reattach, viewport change) must not re-send its starting prompt.
   */
  pendingPrompt?: string;
}

export interface ColumnState {
  id: string;
  panes: PaneState[];
}

/** One conversation's pane grid. */
export interface WorkspaceState {
  /** ≡ the conversationId whose grid this is. */
  id: string;
  columns: ColumnState[];
  activePaneId: string;
  /**
   * The unbound pane whose picker should take focus — set when a split makes a
   * new pane, so the user lands in the picker instead of staring at a blank
   * rectangle hunting for the next click. Cleared once bound or dismissed.
   */
  pendingPickerPaneId: string | null;
}

interface PaneLocation {
  columnIndex: number;
  paneIndex: number;
}

function findPaneLocation(state: WorkspaceState, paneId: string): PaneLocation | null {
  for (let columnIndex = 0; columnIndex < state.columns.length; columnIndex += 1) {
    const paneIndex = state.columns[columnIndex].panes.findIndex((pane) => pane.id === paneId);
    if (paneIndex !== -1) return { columnIndex, paneIndex };
  }
  return null;
}

/**
 * A conversation's opening grid: one pane, already bound to the conversation
 * itself. The grid is never empty and never starts on a picker — opening a
 * conversation shows that conversation.
 */
export function newWorkspace(params: {
  conversationId: string;
  paneId: string;
  columnId: string;
  scope: PaneScope;
}): WorkspaceState {
  return {
    id: params.conversationId,
    columns: [{ id: params.columnId, panes: [{ id: params.paneId, scope: params.scope }] }],
    activePaneId: params.paneId,
    pendingPickerPaneId: null,
  };
}

/** Bind a pane to what the picker chose, and retire the picker for it. */
export function assignPane(state: WorkspaceState, paneId: string, scope: PaneScope): WorkspaceState {
  if (!findPaneLocation(state, paneId)) return state;
  return {
    ...state,
    columns: state.columns.map((column) => ({
      ...column,
      panes: column.panes.map((pane) => (pane.id === paneId ? { ...pane, scope } : pane)),
    })),
    activePaneId: paneId,
    pendingPickerPaneId: state.pendingPickerPaneId === paneId ? null : state.pendingPickerPaneId,
  };
}

export function setPanePendingPrompt(state: WorkspaceState, paneId: string, pendingPrompt: string): WorkspaceState {
  if (!findPaneLocation(state, paneId)) return state;
  return {
    ...state,
    columns: state.columns.map((column) => ({
      ...column,
      panes: column.panes.map((pane) => (pane.id === paneId ? { ...pane, pendingPrompt } : pane)),
    })),
  };
}

/** Clear a delivered prompt so a remount cannot re-send it. */
export function clearPanePrompt(state: WorkspaceState, paneId: string): WorkspaceState {
  if (!findPaneLocation(state, paneId)) return state;
  return {
    ...state,
    columns: state.columns.map((column) => ({
      ...column,
      panes: column.panes.map((pane) => {
        if (pane.id !== paneId) return pane;
        const { pendingPrompt: _dropped, ...rest } = pane;
        return rest;
      }),
    })),
  };
}

export function dismissPicker(state: WorkspaceState, paneId: string): WorkspaceState {
  if (state.pendingPickerPaneId !== paneId) return state;
  return { ...state, pendingPickerPaneId: null };
}

/**
 * Split rightward — a new column holding one new pane, inserted immediately
 * after the source pane's column.
 */
export function splitRight(
  state: WorkspaceState,
  fromPaneId: string,
  newColumnId: string,
  newPaneId: string,
): WorkspaceState {
  const location = findPaneLocation(state, fromPaneId);
  if (!location) return state;

  const columns = [...state.columns];
  columns.splice(location.columnIndex + 1, 0, { id: newColumnId, panes: [{ id: newPaneId, scope: null }] });

  return { ...state, columns, activePaneId: newPaneId, pendingPickerPaneId: newPaneId };
}

/** Split downward — a new pane appended to the source pane's existing column. */
export function splitDown(state: WorkspaceState, fromPaneId: string, newPaneId: string): WorkspaceState {
  const location = findPaneLocation(state, fromPaneId);
  if (!location) return state;

  const columns = state.columns.map((column, columnIndex) =>
    columnIndex === location.columnIndex
      ? { ...column, panes: [...column.panes, { id: newPaneId, scope: null }] }
      : column,
  );

  return { ...state, columns, activePaneId: newPaneId, pendingPickerPaneId: newPaneId };
}

/**
 * Remove a pane. Emptying a column removes the column; closing the active pane
 * re-targets active to the first remaining pane.
 *
 * The LAST pane is deliberately not this function's business: a grid never has
 * zero panes, and closing the only one means the conversation goes back to its
 * single default pane — a decision the caller owns. This no-ops as a backstop
 * rather than filtering down to a `columns[0]` that is not there.
 */
export function closePane(state: WorkspaceState, id: string): WorkspaceState {
  const location = findPaneLocation(state, id);
  if (!location) return state;

  const totalPanes = state.columns.reduce((sum, column) => sum + column.panes.length, 0);
  if (totalPanes <= 1) return state;

  const columns = state.columns
    .map((column, columnIndex) =>
      columnIndex === location.columnIndex
        ? { ...column, panes: column.panes.filter((pane) => pane.id !== id) }
        : column,
    )
    .filter((column) => column.panes.length > 0);

  const activePaneId = state.activePaneId === id ? columns[0].panes[0].id : state.activePaneId;
  const pendingPickerPaneId = state.pendingPickerPaneId === id ? null : state.pendingPickerPaneId;

  return { ...state, columns, activePaneId, pendingPickerPaneId };
}

export function selectPane(state: WorkspaceState, id: string): WorkspaceState {
  if (!findPaneLocation(state, id)) return state;
  return { ...state, activePaneId: id };
}

/** Every pane, flattened in visual order (left-to-right, top-to-bottom). */
export function panesOf(state: WorkspaceState): PaneState[] {
  return state.columns.flatMap((column) => column.panes);
}

/** The pane bound to a given target, if any — used to focus rather than duplicate. */
export function paneShowing(state: WorkspaceState, targetId: string): PaneState | undefined {
  return panesOf(state).find((pane) => pane.scope?.targetId === targetId);
}
