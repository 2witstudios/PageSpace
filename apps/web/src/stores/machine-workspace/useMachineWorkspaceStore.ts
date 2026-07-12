/**
 * Machine Workspace Store
 *
 * Thin imperative shell over the pure workspace-reducer.
 *
 * NODE-AS-WORKSPACE: a grid is keyed per NODE — `(machineId, projectName?,
 * branchName?)` — not one grid per machine. Every Machine/Project/Branch node
 * owns a persistent pane grid (a branch node's grid holds the agents working in
 * that branch's checkout), and the machine has one ACTIVE node at a time, whose
 * grid is what the workspace region renders. Selecting a node again restores
 * its grid (the PTYs behind it survive the reap window, so the panes reattach).
 *
 * Fresh ids are generated here (crypto.randomUUID) — the reducer itself never
 * generates ids, keeping it deterministic and trivially testable.
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
  workspaceKey,
  nodeOfTerminalScope,
  isSameNodeScope,
  MACHINE_NODE_SCOPE,
  openTerminal as openTerminalTransition,
  assignPane as assignPaneTransition,
  clearPanePrompt as clearPanePromptTransition,
  dismissPicker as dismissPickerTransition,
  splitRight as splitRightTransition,
  splitDown as splitDownTransition,
  closePane as closePaneTransition,
  selectPane as selectPaneTransition,
  autoSessionName,
  type MachineNodeScope,
  type OpenTerminalScope,
  type TerminalColumnState,
  type TerminalPaneState,
  type WorkspaceState,
} from './workspace-reducer';

export type { MachineNodeScope, OpenTerminalScope, TerminalColumnState, TerminalPaneState, WorkspaceState };
export { autoSessionName, MACHINE_NODE_SCOPE };

interface MachineWorkspaceStoreState {
  /** Keyed by `workspaceKey(machineId, node)` — one grid per node, not per machine. */
  workspaces: Record<string, WorkspaceState>;
  /** The node whose grid the workspace region is showing, keyed by machineId. */
  activeNodes: Record<string, MachineNodeScope>;
  ensureWorkspace: (machineId: string) => void;
  disposeWorkspace: (machineId: string) => void;
  /** Shows `node`'s grid, creating an empty one the first time that node is opened. */
  selectNode: (machineId: string, node: MachineNodeScope) => void;
  openTerminal: (machineId: string, scope: OpenTerminalScope) => void;
  /** Split-and-pick's landing step: bind a just-spawned session to the pane it was picked in. */
  bindPaneTerminal: (machineId: string, paneId: string, scope: OpenTerminalScope, pendingPrompt?: string) => void;
  clearPanePrompt: (machineId: string, paneId: string) => void;
  dismissPicker: (machineId: string, paneId: string) => void;
  splitRight: (machineId: string, fromPaneId: string) => void;
  splitDown: (machineId: string, fromPaneId: string) => void;
  closePane: (machineId: string, paneId: string) => void;
  selectPane: (machineId: string, paneId: string) => void;
}

/** The node a machine is currently showing — machine scope until something selects otherwise. */
function activeNodeOf(state: MachineWorkspaceStoreState, machineId: string): MachineNodeScope {
  return state.activeNodes[machineId] ?? MACHINE_NODE_SCOPE;
}

/** Applies a pure reducer transition to the machine's ACTIVE node's workspace,
 * if it exists — a missing workspace (not yet ensured, or already disposed) is
 * a no-op rather than an error. */
function applyTransition(
  state: MachineWorkspaceStoreState,
  machineId: string,
  transition: (workspace: WorkspaceState) => WorkspaceState
): Pick<MachineWorkspaceStoreState, 'workspaces'> {
  const key = workspaceKey(machineId, activeNodeOf(state, machineId));
  const workspace = state.workspaces[key];
  if (!workspace) return { workspaces: state.workspaces };
  return {
    workspaces: { ...state.workspaces, [key]: transition(workspace) },
  };
}

export const useMachineWorkspaceStore = create<MachineWorkspaceStoreState>((set, get) => ({
  workspaces: {},
  activeNodes: {},

  ensureWorkspace: (machineId) => {
    const state = get();
    const key = workspaceKey(machineId, activeNodeOf(state, machineId));
    if (state.workspaces[key]) return;
    set((current) => ({
      workspaces: {
        ...current.workspaces,
        [key]: initialWorkspace(crypto.randomUUID()),
      },
    }));
  },

  disposeWorkspace: (machineId) => {
    set((state) => {
      // Every node of this machine goes, not just the active one — the whole
      // Machine page unmounted, and a per-node grid outliving it would be a leak
      // that a later mount silently inherits.
      const prefix = `${machineId}\u0000`;
      const workspaces = Object.fromEntries(
        Object.entries(state.workspaces).filter(([key]) => !key.startsWith(prefix))
      );
      const activeNodes = { ...state.activeNodes };
      delete activeNodes[machineId];
      return { workspaces, activeNodes };
    });
  },

  selectNode: (machineId, node) => {
    set((state) => {
      const key = workspaceKey(machineId, node);
      const workspaces = state.workspaces[key]
        ? state.workspaces
        : { ...state.workspaces, [key]: initialWorkspace(crypto.randomUUID()) };
      return { workspaces, activeNodes: { ...state.activeNodes, [machineId]: node } };
    });
  },

  openTerminal: (machineId, scope) => {
    // A session belongs to exactly one node, so opening it means showing that
    // node's grid — otherwise the terminal would land in whatever grid happened
    // to be on screen, in a checkout it doesn't run in.
    const node = nodeOfTerminalScope(scope);
    const state = get();
    if (!isSameNodeScope(activeNodeOf(state, machineId), node) || !state.workspaces[workspaceKey(machineId, node)]) {
      state.selectNode(machineId, node);
    }
    set((current) => applyTransition(current, machineId, (workspace) => openTerminalTransition(workspace, scope)));
  },

  bindPaneTerminal: (machineId, paneId, scope, pendingPrompt) => {
    set((state) =>
      applyTransition(state, machineId, (workspace) => assignPaneTransition(workspace, paneId, scope, pendingPrompt))
    );
  },

  clearPanePrompt: (machineId, paneId) => {
    set((state) => applyTransition(state, machineId, (workspace) => clearPanePromptTransition(workspace, paneId)));
  },

  dismissPicker: (machineId, paneId) => {
    set((state) => applyTransition(state, machineId, (workspace) => dismissPickerTransition(workspace, paneId)));
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

/** The grid on screen for this machine: its ACTIVE node's. */
export const selectWorkspace = (machineId: string) => (state: MachineWorkspaceStoreState) =>
  state.workspaces[workspaceKey(machineId, activeNodeOf(state, machineId))];

/** The node the visible grid belongs to — the scope a pane's picker spawns into.
 * Falls back to the shared MACHINE_NODE_SCOPE constant (not a fresh `{}`), so
 * subscribing to this doesn't re-render on every unrelated store write. */
export const selectActiveNode = (machineId: string) => (state: MachineWorkspaceStoreState) =>
  activeNodeOf(state, machineId);

/** One node's grid, whether or not it's the one on screen — for a caller that
 * needs another node's state (e.g. how many panes a branch is running). */
export const selectNodeWorkspace = (machineId: string, node: MachineNodeScope) => (state: MachineWorkspaceStoreState) =>
  state.workspaces[workspaceKey(machineId, node)];
