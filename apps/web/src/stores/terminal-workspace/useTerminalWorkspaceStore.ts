/**
 * Terminal Workspace Store
 *
 * Thin imperative shell over the pure workspace-reducer. Keyed by
 * `terminalId` (the Terminal page's own id) so several Terminal pages can
 * hold independent pane layouts at once. Fresh ids are generated here
 * (crypto.randomUUID) — the reducer itself never generates ids, keeping it
 * deterministic and trivially testable.
 *
 * This is the single source of truth shared, by composition, between the
 * Navigator (right sidebar) and TerminalPanes (middle content) — they no
 * longer need a common parent to share `columns`/`activePaneId` local state.
 *
 * Navigation cleanup (dispose on unmount) is performed by the mounting
 * component via `useEffect`, not from inside the store — same pattern as
 * useThreadPanelStore.
 */

import { create } from 'zustand';
import {
  initialWorkspace,
  openTerminal as openTerminalTransition,
  splitRight as splitRightTransition,
  splitDown as splitDownTransition,
  closePane as closePaneTransition,
  selectPane as selectPaneTransition,
  type OpenTerminalScope,
  type TerminalPaneState,
  type TerminalColumnState,
  type WorkspaceState,
} from './workspace-reducer';

export type { OpenTerminalScope, TerminalPaneState, TerminalColumnState, WorkspaceState };

interface TerminalWorkspaceStoreState {
  workspaces: Record<string, WorkspaceState>;
  ensureWorkspace: (terminalId: string) => void;
  disposeWorkspace: (terminalId: string) => void;
  openTerminal: (terminalId: string, scope: OpenTerminalScope) => void;
  splitRight: (terminalId: string, paneId: string) => void;
  splitDown: (terminalId: string, paneId: string) => void;
  closePane: (terminalId: string, paneId: string) => void;
  selectPane: (terminalId: string, paneId: string) => void;
}

/** Applies a pure reducer transition to the workspace at `terminalId`, if it
 * exists — a missing workspace (not yet ensured, or already disposed) is a
 * no-op rather than an error. */
function applyTransition(
  state: TerminalWorkspaceStoreState,
  terminalId: string,
  transition: (workspace: WorkspaceState) => WorkspaceState
): Pick<TerminalWorkspaceStoreState, 'workspaces'> {
  const workspace = state.workspaces[terminalId];
  if (!workspace) return { workspaces: state.workspaces };
  return {
    workspaces: { ...state.workspaces, [terminalId]: transition(workspace) },
  };
}

export const useTerminalWorkspaceStore = create<TerminalWorkspaceStoreState>((set, get) => ({
  workspaces: {},

  ensureWorkspace: (terminalId) => {
    if (get().workspaces[terminalId]) return;
    set((state) => ({
      workspaces: {
        ...state.workspaces,
        [terminalId]: initialWorkspace(crypto.randomUUID(), crypto.randomUUID()),
      },
    }));
  },

  disposeWorkspace: (terminalId) => {
    set((state) => {
      if (!(terminalId in state.workspaces)) return state;
      const workspaces = { ...state.workspaces };
      delete workspaces[terminalId];
      return { workspaces };
    });
  },

  openTerminal: (terminalId, scope) => {
    set((state) => applyTransition(state, terminalId, (workspace) => openTerminalTransition(workspace, scope)));
  },

  splitRight: (terminalId, paneId) => {
    const newColumnId = crypto.randomUUID();
    const newPaneId = crypto.randomUUID();
    set((state) => applyTransition(state, terminalId, (workspace) => splitRightTransition(workspace, paneId, newColumnId, newPaneId)));
  },

  splitDown: (terminalId, paneId) => {
    const newPaneId = crypto.randomUUID();
    set((state) => applyTransition(state, terminalId, (workspace) => splitDownTransition(workspace, paneId, newPaneId)));
  },

  closePane: (terminalId, paneId) => {
    set((state) => applyTransition(state, terminalId, (workspace) => closePaneTransition(workspace, paneId)));
  },

  selectPane: (terminalId, paneId) => {
    set((state) => applyTransition(state, terminalId, (workspace) => selectPaneTransition(workspace, paneId)));
  },
}));

export const selectWorkspace = (terminalId: string) => (state: TerminalWorkspaceStoreState) =>
  state.workspaces[terminalId];
