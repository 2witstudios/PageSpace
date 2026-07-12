/**
 * Machine Workspace Store
 *
 * Thin imperative shell over the pure workspace-reducer.
 *
 * A machine holds MANY workspaces — each a sidebar item owning its own pane
 * grid — and exactly one is active. `MachineWorkspace` renders the ACTIVE
 * workspace's grid, so `setActiveWorkspace` switches the entire middle view to
 * that item's combination of terminals. That correspondence is the point: the
 * store this replaced held one grid per machine, and "opening" a terminal only
 * overwrote the active pane, so clicking sidebar items never switched the view.
 *
 * Persisted: a workspace's panes outlive a reload, and the PTYs behind them
 * survive their reap window, so a restored grid reattaches to running agents.
 *
 * Fresh ids are generated here (crypto.randomUUID) — the reducer itself never
 * generates ids, keeping it deterministic and trivially testable.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  newWorkspace,
  initialMachineWorkspaces,
  addWorkspace,
  updateWorkspace,
  sessionWorkspaceId,
  nextWorkspaceName,
  setActiveWorkspace as setActiveWorkspaceTransition,
  assignPane as assignPaneTransition,
  clearPanePrompt as clearPanePromptTransition,
  dismissPicker as dismissPickerTransition,
  splitRight as splitRightTransition,
  splitDown as splitDownTransition,
  closePane as closePaneTransition,
  selectPane as selectPaneTransition,
  nodeOfTerminalScope,
  panesOf,
  autoSessionName,
  MACHINE_NODE_SCOPE,
  type MachineNodeScope,
  type MachineWorkspacesState,
  type OpenTerminalScope,
  type TerminalColumnState,
  type TerminalPaneState,
  type WorkspaceState,
} from './workspace-reducer';

export type {
  MachineNodeScope,
  MachineWorkspacesState,
  OpenTerminalScope,
  TerminalColumnState,
  TerminalPaneState,
  WorkspaceState,
};
export { autoSessionName, panesOf, MACHINE_NODE_SCOPE };

interface MachineWorkspaceStoreState {
  /** Every machine's workspaces, keyed by the Machine page's own id. */
  machines: Record<string, MachineWorkspacesState>;
  /** Creates the machine's first workspace if it has none. Idempotent. */
  ensureMachine: (machineId: string) => void;
  /** A new empty workspace (auto-named), shown immediately. Returns its id. */
  createWorkspace: (machineId: string, scope?: MachineNodeScope) => string;
  /** THE FIX: switches the whole middle view to this workspace's grid. */
  setActiveWorkspace: (machineId: string, workspaceId: string) => void;
  /** Opens an existing session: its own workspace, restored if it already has
   * one, and shown. */
  openTerminal: (machineId: string, scope: OpenTerminalScope) => void;
  /** Split-and-pick's landing step. Returns false when the pane is gone (its
   * workspace closed, the page navigated away) so the caller can clean up the
   * session it just created rather than strand it. */
  bindPaneTerminal: (
    machineId: string,
    workspaceId: string,
    paneId: string,
    scope: OpenTerminalScope,
    pendingPrompt?: string
  ) => boolean;
  clearPanePrompt: (machineId: string, workspaceId: string, paneId: string) => void;
  dismissPicker: (machineId: string, workspaceId: string, paneId: string) => void;
  splitRight: (machineId: string, workspaceId: string, fromPaneId: string) => void;
  splitDown: (machineId: string, workspaceId: string, fromPaneId: string) => void;
  closePane: (machineId: string, workspaceId: string, paneId: string) => void;
  selectPane: (machineId: string, workspaceId: string, paneId: string) => void;
}

/** Applies a machine-level transition, if that machine has any workspaces —
 * a machine that was never ensured is a no-op rather than an error. */
function applyToMachine(
  state: MachineWorkspaceStoreState,
  machineId: string,
  transition: (machine: MachineWorkspacesState) => MachineWorkspacesState
): Pick<MachineWorkspaceStoreState, 'machines'> {
  const machine = state.machines[machineId];
  if (!machine) return { machines: state.machines };

  const next = transition(machine);
  if (next === machine) return { machines: state.machines };

  return { machines: { ...state.machines, [machineId]: next } };
}

/** Applies a GRID transition to one workspace of one machine, addressed by id —
 * never "the active one", which can change between a user's action and the
 * write it causes (see `updateWorkspace`). */
function applyToWorkspace(
  state: MachineWorkspaceStoreState,
  machineId: string,
  workspaceId: string,
  transition: (workspace: WorkspaceState) => WorkspaceState
): Pick<MachineWorkspaceStoreState, 'machines'> {
  return applyToMachine(state, machineId, (machine) => updateWorkspace(machine, workspaceId, transition));
}

export const useMachineWorkspaceStore = create<MachineWorkspaceStoreState>()(
  persist(
    (set, get) => ({
      machines: {},

      ensureMachine: (machineId) => {
        if (get().machines[machineId]) return;
        set((state) => ({
          machines: {
            ...state.machines,
            [machineId]: initialMachineWorkspaces(
              newWorkspace({
                id: crypto.randomUUID(),
                name: 'Workspace 1',
                scope: MACHINE_NODE_SCOPE,
                firstPaneId: crypto.randomUUID(),
              })
            ),
          },
        }));
      },

      createWorkspace: (machineId, scope = MACHINE_NODE_SCOPE) => {
        get().ensureMachine(machineId);
        const machine = get().machines[machineId];
        const workspace = newWorkspace({
          id: crypto.randomUUID(),
          name: nextWorkspaceName(machine),
          scope,
          firstPaneId: crypto.randomUUID(),
        });
        set((state) => applyToMachine(state, machineId, (current) => addWorkspace(current, workspace)));
        return workspace.id;
      },

      setActiveWorkspace: (machineId, workspaceId) => {
        set((state) => applyToMachine(state, machineId, (machine) => setActiveWorkspaceTransition(machine, workspaceId)));
      },

      openTerminal: (machineId, scope) => {
        get().ensureMachine(machineId);
        const machine = get().machines[machineId];
        const workspaceId = sessionWorkspaceId(scope);

        // Already has a workspace: show it as the user last left it — panes they
        // split into it and the agents in them, not just this one session.
        if (machine.workspaces[workspaceId]) {
          set((state) =>
            applyToMachine(state, machineId, (current) => setActiveWorkspaceTransition(current, workspaceId))
          );
          return;
        }

        const workspace = newWorkspace({
          id: workspaceId,
          name: scope.name,
          scope: nodeOfTerminalScope(scope),
          firstPaneId: crypto.randomUUID(),
          firstPaneScope: scope,
        });
        set((state) => applyToMachine(state, machineId, (current) => addWorkspace(current, workspace)));
      },

      bindPaneTerminal: (machineId, workspaceId, paneId, scope, pendingPrompt) => {
        const before = get().machines[machineId]?.workspaces[workspaceId];
        if (!before) return false;

        const after = assignPaneTransition(before, paneId, scope, pendingPrompt);
        // assignPane returns its input untouched when the pane is gone — the
        // user closed it (or left the page) while the Sprite was booting.
        if (after === before) return false;

        set((state) => applyToWorkspace(state, machineId, workspaceId, () => after));
        return true;
      },

      clearPanePrompt: (machineId, workspaceId, paneId) => {
        set((state) =>
          applyToWorkspace(state, machineId, workspaceId, (workspace) => clearPanePromptTransition(workspace, paneId))
        );
      },

      dismissPicker: (machineId, workspaceId, paneId) => {
        set((state) =>
          applyToWorkspace(state, machineId, workspaceId, (workspace) => dismissPickerTransition(workspace, paneId))
        );
      },

      splitRight: (machineId, workspaceId, fromPaneId) => {
        const newColumnId = crypto.randomUUID();
        const newPaneId = crypto.randomUUID();
        set((state) =>
          applyToWorkspace(state, machineId, workspaceId, (workspace) =>
            splitRightTransition(workspace, fromPaneId, newColumnId, newPaneId)
          )
        );
      },

      splitDown: (machineId, workspaceId, fromPaneId) => {
        const newPaneId = crypto.randomUUID();
        set((state) =>
          applyToWorkspace(state, machineId, workspaceId, (workspace) =>
            splitDownTransition(workspace, fromPaneId, newPaneId)
          )
        );
      },

      closePane: (machineId, workspaceId, paneId) => {
        set((state) =>
          applyToWorkspace(state, machineId, workspaceId, (workspace) => closePaneTransition(workspace, paneId))
        );
      },

      selectPane: (machineId, workspaceId, paneId) => {
        set((state) =>
          applyToWorkspace(state, machineId, workspaceId, (workspace) => selectPaneTransition(workspace, paneId))
        );
      },
    }),
    {
      name: 'machine-workspace-storage',
      // Only the shape — the actions are rebuilt on every load. A restored grid
      // reattaches to its PTYs, which is the whole reason to persist it.
      partialize: (state) => ({ machines: state.machines }),
    }
  )
);

/** The grid the middle view shows: the active workspace's. */
export const selectActiveWorkspace = (machineId: string) => (state: MachineWorkspaceStoreState) => {
  const machine = state.machines[machineId];
  return machine ? machine.workspaces[machine.activeWorkspaceId] : undefined;
};

/** A machine's whole workspace set — for the sidebar items that select them
 * (sub-task 3). Returns the STATE object, not a derived array: a selector that
 * built a fresh array per call would hand React a new snapshot on every store
 * read. Derive the ordered list from it with `workspacesOf`. */
export const selectMachine = (machineId: string) => (state: MachineWorkspaceStoreState) =>
  state.machines[machineId];

export const selectWorkspace = (machineId: string, workspaceId: string) => (state: MachineWorkspaceStoreState) =>
  state.machines[machineId]?.workspaces[workspaceId];
