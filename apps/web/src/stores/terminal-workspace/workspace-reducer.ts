/**
 * Terminal Workspace — functional core.
 *
 * Pure, framework-free state transitions for the pane layout shared between
 * the Terminal page's Navigator (right sidebar) and TerminalPanes (middle
 * content). IDs are passed in rather than generated here, so every
 * transition is deterministic and independently testable.
 *
 * Layout is a two-level structure — a horizontal row of columns, each an
 * independent vertical stack of panes — deliberately not a full recursive
 * split tree. splitRight adds a column; splitDown stacks within one.
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

export function initialWorkspace(firstId: string): WorkspaceState {
  return {
    columns: [{ id: firstId, panes: [{ id: firstId, scope: null }] }],
    activePaneId: firstId,
  };
}

function findPaneLocation(
  state: WorkspaceState,
  paneId: string
): { columnIndex: number; paneIndex: number } | null {
  for (let columnIndex = 0; columnIndex < state.columns.length; columnIndex++) {
    const paneIndex = state.columns[columnIndex].panes.findIndex((pane) => pane.id === paneId);
    if (paneIndex !== -1) return { columnIndex, paneIndex };
  }
  return null;
}

/** Opens a terminal into the ACTIVE pane — an explicit target rather than
 * guessing from array position, which would silently overwrite the wrong
 * pane whenever a second pane existed. */
export function openTerminal(state: WorkspaceState, scope: OpenTerminalScope): WorkspaceState {
  return {
    ...state,
    columns: state.columns.map((column) => ({
      ...column,
      panes: column.panes.map((pane) => (pane.id === state.activePaneId ? { ...pane, scope } : pane)),
    })),
  };
}

/** Splits `fromPaneId` rightward — a new column, with one new pane, inserted
 * immediately after `fromPaneId`'s column. */
export function splitRight(
  state: WorkspaceState,
  fromPaneId: string,
  newColumnId: string,
  newPaneId: string
): WorkspaceState {
  const location = findPaneLocation(state, fromPaneId);
  const insertAt = location ? location.columnIndex + 1 : state.columns.length;

  const columns = [...state.columns];
  columns.splice(insertAt, 0, { id: newColumnId, panes: [{ id: newPaneId, scope: null }] });

  return { columns, activePaneId: newPaneId };
}

/** Splits `fromPaneId` downward — a new pane appended to `fromPaneId`'s
 * existing column. */
export function splitDown(state: WorkspaceState, fromPaneId: string, newPaneId: string): WorkspaceState {
  const location = findPaneLocation(state, fromPaneId);
  if (!location) return state;

  const columns = state.columns.map((column, columnIndex) =>
    columnIndex === location.columnIndex
      ? { ...column, panes: [...column.panes, { id: newPaneId, scope: null }] }
      : column
  );

  return { columns, activePaneId: newPaneId };
}

/** Removing the very last remaining pane is a no-op — a workspace never has
 * zero panes. Closing the last pane in a column removes the column too;
 * closing the active pane re-targets active to the first remaining pane. */
export function closePane(state: WorkspaceState, id: string): WorkspaceState {
  const location = findPaneLocation(state, id);
  if (!location) return state;

  const totalPanes = state.columns.reduce((sum, column) => sum + column.panes.length, 0);
  if (totalPanes <= 1) return state;

  const columns = state.columns
    .map((column, columnIndex) =>
      columnIndex === location.columnIndex
        ? { ...column, panes: column.panes.filter((pane) => pane.id !== id) }
        : column
    )
    .filter((column) => column.panes.length > 0);

  const activePaneId = state.activePaneId === id ? columns[0].panes[0].id : state.activePaneId;

  return { columns, activePaneId };
}

export function selectPane(state: WorkspaceState, id: string): WorkspaceState {
  if (!findPaneLocation(state, id)) return state;
  return { ...state, activePaneId: id };
}
