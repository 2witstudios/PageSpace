/**
 * Terminal Workspace — functional core.
 *
 * Pure, framework-free state transitions for the pane layout shared between
 * the Terminal page's Navigator (right sidebar) and TerminalPanes (middle
 * content). IDs are passed in rather than generated here, so every
 * transition is deterministic and independently testable.
 *
 * Layout is a two-level structure: a top-level row of columns, each column
 * an independent vertical stack of panes. This is the smallest change that
 * gets both split-right (new column) and split-down (stack within a column)
 * without a full arbitrary recursive split tree.
 */

/** Identifies which terminal to open in a pane — neither `projectName` nor
 * `branchName` set is machine scope, `projectName` alone is project scope,
 * both is branch scope. */
export interface OpenTerminalScope {
  projectName?: string;
  branchName?: string;
  name: string;
}

export interface TerminalPaneState {
  id: string;
  scope: OpenTerminalScope | null;
}

export interface TerminalColumnState {
  id: string;
  panes: TerminalPaneState[];
}

export interface WorkspaceState {
  columns: TerminalColumnState[];
  activePaneId: string;
}

function findColumnIndexForPane(state: WorkspaceState, paneId: string): number {
  return state.columns.findIndex((column) => column.panes.some((pane) => pane.id === paneId));
}

export function initialWorkspace(columnId: string, firstPaneId: string): WorkspaceState {
  return {
    columns: [{ id: columnId, panes: [{ id: firstPaneId, scope: null }] }],
    activePaneId: firstPaneId,
  };
}

/** Opens a terminal into the ACTIVE pane — an explicit target rather than
 * guessing from array position, which would silently overwrite the wrong
 * pane whenever more than one pane existed. */
export function openTerminal(state: WorkspaceState, scope: OpenTerminalScope): WorkspaceState {
  return {
    ...state,
    columns: state.columns.map((column) => ({
      ...column,
      panes: column.panes.map((pane) => (pane.id === state.activePaneId ? { ...pane, scope } : pane)),
    })),
  };
}

/** Inserts a new column (one empty pane) immediately to the right of
 * `paneId`'s column, and activates the new pane. */
export function splitRight(state: WorkspaceState, paneId: string, newColumnId: string, newPaneId: string): WorkspaceState {
  const columnIndex = findColumnIndexForPane(state, paneId);
  const insertAt = columnIndex === -1 ? state.columns.length : columnIndex + 1;

  const columns = [...state.columns];
  columns.splice(insertAt, 0, { id: newColumnId, panes: [{ id: newPaneId, scope: null }] });

  return { columns, activePaneId: newPaneId };
}

/** Appends a new empty pane directly below `paneId` within its existing
 * column, and activates the new pane. A no-op if `paneId` isn't found. */
export function splitDown(state: WorkspaceState, paneId: string, newPaneId: string): WorkspaceState {
  const columnIndex = findColumnIndexForPane(state, paneId);
  if (columnIndex === -1) return state;

  const column = state.columns[columnIndex];
  const paneIndex = column.panes.findIndex((pane) => pane.id === paneId);

  const panes = [...column.panes];
  panes.splice(paneIndex + 1, 0, { id: newPaneId, scope: null });

  const columns = state.columns.map((c, i) => (i === columnIndex ? { ...c, panes } : c));

  return { columns, activePaneId: newPaneId };
}

/** Removing the very last remaining pane (across all columns) is a no-op —
 * a workspace never has zero panes. Closing the last pane in a column
 * removes the column; closing the active pane re-targets active to the
 * workspace's first remaining pane. */
export function closePane(state: WorkspaceState, id: string): WorkspaceState {
  const totalPanes = state.columns.reduce((sum, column) => sum + column.panes.length, 0);
  if (totalPanes <= 1) return state;

  const columnIndex = findColumnIndexForPane(state, id);
  if (columnIndex === -1) return state;

  const remainingPanes = state.columns[columnIndex].panes.filter((pane) => pane.id !== id);

  const columns =
    remainingPanes.length === 0
      ? state.columns.filter((_, i) => i !== columnIndex)
      : state.columns.map((column, i) => (i === columnIndex ? { ...column, panes: remainingPanes } : column));

  const activePaneId = state.activePaneId === id ? columns[0].panes[0].id : state.activePaneId;

  return { columns, activePaneId };
}

export function selectPane(state: WorkspaceState, id: string): WorkspaceState {
  const exists = state.columns.some((column) => column.panes.some((pane) => pane.id === id));
  if (!exists) return state;
  return { ...state, activePaneId: id };
}
