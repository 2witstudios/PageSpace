/**
 * Terminal Workspace — functional core.
 *
 * Pure, framework-free state transitions for the pane layout shared between
 * the Terminal page's Navigator (right sidebar) and TerminalPanes (middle
 * content). IDs are passed in rather than generated here, so every
 * transition is deterministic and independently testable.
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

export interface WorkspaceState {
  panes: TerminalPaneState[];
  activePaneId: string;
}

export function initialWorkspace(firstId: string): WorkspaceState {
  return {
    panes: [{ id: firstId, scope: null }],
    activePaneId: firstId,
  };
}

/** Opens a terminal into the ACTIVE pane — an explicit target rather than
 * guessing from array position, which would silently overwrite the wrong
 * pane whenever a second pane existed. */
export function openTerminal(state: WorkspaceState, scope: OpenTerminalScope): WorkspaceState {
  return {
    ...state,
    panes: state.panes.map((pane) =>
      pane.id === state.activePaneId ? { ...pane, scope } : pane
    ),
  };
}

export function split(state: WorkspaceState, newId: string): WorkspaceState {
  return {
    panes: [...state.panes, { id: newId, scope: null }],
    activePaneId: newId,
  };
}

/** Removing the last remaining pane is a no-op — a workspace never has zero
 * panes. Removing the active pane re-targets active to the first remaining
 * pane. */
export function closePane(state: WorkspaceState, id: string): WorkspaceState {
  if (state.panes.length <= 1) return state;

  const panes = state.panes.filter((pane) => pane.id !== id);
  const activePaneId = state.activePaneId === id ? panes[0].id : state.activePaneId;

  return { panes, activePaneId };
}

export function selectPane(state: WorkspaceState, id: string): WorkspaceState {
  if (!state.panes.some((pane) => pane.id === id)) return state;
  return { ...state, activePaneId: id };
}
