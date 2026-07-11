/**
 * Machine Workspace Store
 *
 * Thin imperative shell over the pure workspace-reducer. Keyed by
 * `machineId` (the Machine page's own id) so several Machine pages can
 * hold independent pane layouts at once. Fresh ids are generated here
 * (crypto.randomUUID) — the reducer itself never generates ids, keeping it
 * deterministic and trivially testable.
 *
 * This is the single source of truth shared, by composition, between the
 * Machine tree sidebar (Terminal tab) and TerminalPanes (its pane region) —
 * they no longer need a common parent to share `columns`/`activePaneId` state.
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
  type TerminalColumnState,
  type TerminalPaneState,
  type WorkspaceState,
} from './workspace-reducer';

export type { OpenTerminalScope, TerminalColumnState, TerminalPaneState, WorkspaceState };

interface MachineWorkspaceStoreState {
  workspaces: Record<string, WorkspaceState>;
  ensureWorkspace: (machineId: string) => void;
  disposeWorkspace: (machineId: string) => void;
  openTerminal: (machineId: string, scope: OpenTerminalScope) => void;
  splitRight: (machineId: string, fromPaneId: string) => void;
  splitDown: (machineId: string, fromPaneId: string) => void;
  closePane: (machineId: string, paneId: string) => void;
  selectPane: (machineId: string, paneId: string) => void;
}

/** Applies a pure reducer transition to the workspace at `machineId`, if it
 * exists — a missing workspace (not yet ensured, or already disposed) is a
 * no-op rather than an error. */
function applyTransition(
  state: MachineWorkspaceStoreState,
  machineId: string,
  transition: (workspace: WorkspaceState) => WorkspaceState
): Pick<MachineWorkspaceStoreState, 'workspaces'> {
  const workspace = state.workspaces[machineId];
  if (!workspace) return { workspaces: state.workspaces };
  return {
    workspaces: { ...state.workspaces, [machineId]: transition(workspace) },
  };
}

export const useMachineWorkspaceStore = create<MachineWorkspaceStoreState>((set, get) => ({
  workspaces: {},

  ensureWorkspace: (machineId) => {
    if (get().workspaces[machineId]) return;
    set((state) => ({
      workspaces: {
        ...state.workspaces,
        [machineId]: initialWorkspace(crypto.randomUUID()),
      },
    }));
  },

  disposeWorkspace: (machineId) => {
    set((state) => {
      if (!(machineId in state.workspaces)) return state;
      const workspaces = { ...state.workspaces };
      delete workspaces[machineId];
      return { workspaces };
    });
  },

  openTerminal: (machineId, scope) => {
    set((state) => applyTransition(state, machineId, (workspace) => openTerminalTransition(workspace, scope)));
  },

  splitRight: (machineId, fromPaneId) => {
    const newColumnId = crypto.randomUUID();
    const newPaneId = crypto.randomUUID();
    set((state) =>
      applyTransition(state, machineId, (workspace) => splitRightTransition(workspace, fromPaneId, newColumnId, newPaneId))
    );
  },

  splitDown: (machineId, fromPaneId) => {
    const newPaneId = crypto.randomUUID();
    set((state) => applyTransition(state, machineId, (workspace) => splitDownTransition(workspace, fromPaneId, newPaneId)));
  },

  closePane: (machineId, paneId) => {
    set((state) => applyTransition(state, machineId, (workspace) => closePaneTransition(workspace, paneId)));
  },

  selectPane: (machineId, paneId) => {
    set((state) => applyTransition(state, machineId, (workspace) => selectPaneTransition(workspace, paneId)));
  },
}));

export const selectWorkspace = (machineId: string) => (state: MachineWorkspaceStoreState) =>
  state.workspaces[machineId];
