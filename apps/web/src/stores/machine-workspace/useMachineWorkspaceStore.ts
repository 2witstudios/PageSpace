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
  addWorkspace,
  updateWorkspace,
  removeWorkspace as removeWorkspaceTransition,
  renameWorkspace as renameWorkspaceTransition,
  showSessionIn,
  workspaceShowing,
  paneShowing,
  sanitizeMachines,
  mergeServerWorkspaces,
  applyServerWorkspaceUpsert,
  applyServerWorkspaceDeleted,
  sessionWorkspaceId,
  nextWorkspaceName,
  setActiveWorkspace as setActiveWorkspaceTransition,
  assignPane as assignPaneTransition,
  clearPanePrompt as clearPanePromptTransition,
  dismissPicker as dismissPickerTransition,
  splitRight as splitRightTransition,
  splitDown as splitDownTransition,
  closePaneIn,
  removedWorkspaceBy,
  selectPane as selectPaneTransition,
  nodeOfTerminalScope,
  nodeScopeNames,
  machineNodeScope,
  paneScopeOf,
  paneScopeForWire,
  paneTerminalScope,
  panesOf,
  workspacesOf,
  isSameNodeScope,
  childSessionIds,
  runningPaneCount,
  autoSessionName,
  MACHINE_NODE_SCOPE,
  type MachineNodeScope,
  type MachineWorkspacesState,
  type OpenTerminalScope,
  type PaneSessionScope,
  type ServerColumnDTO,
  type ServerWorkspaceDTO,
  type TerminalColumnState,
  type TerminalPaneState,
  type WorkspaceState,
} from './workspace-reducer';

export type {
  MachineNodeScope,
  MachineWorkspacesState,
  OpenTerminalScope,
  PaneSessionScope,
  ServerColumnDTO,
  ServerWorkspaceDTO,
  TerminalColumnState,
  TerminalPaneState,
  WorkspaceState,
};
export {
  autoSessionName,
  paneTerminalScope,
  paneScopeForWire,
  nodeScopeNames,
  machineNodeScope,
  panesOf,
  workspacesOf,
  isSameNodeScope,
  sessionWorkspaceId,
  MACHINE_NODE_SCOPE,
  workspaceShowing,
};

/** Bump when the persisted shape changes; see the `migrate`/`merge` note below. */
const PERSISTED_VERSION = 1;

interface MachineWorkspaceStoreState {
  /** Every machine's workspaces, keyed by the Machine page's own id. */
  machines: Record<string, MachineWorkspacesState>;
  /** Creates the machine's entry (with zero workspaces) if it has none, and
   * re-targets an `activeWorkspaceId` that doesn't resolve. Never creates a
   * workspace — zero is a legal state. Idempotent. */
  ensureMachine: (machineId: string) => void;
  /** A new empty workspace (auto-named), shown immediately. Returns its id. */
  createWorkspace: (machineId: string, scope?: MachineNodeScope) => string;
  /** THE FIX: switches the whole middle view to this workspace's grid. */
  setActiveWorkspace: (machineId: string, workspaceId: string) => void;
  /** Drops a workspace and shows a neighbour — including the last one, which
   * leaves the machine empty. */
  removeWorkspace: (machineId: string, workspaceId: string) => void;
  /** Local rename — the server-synced wrapper (`useMachineWorkspaceSync`) pushes this to the server too. */
  renameWorkspace: (machineId: string, workspaceId: string, name: string) => void;
  /** Reconciles a machine's FULL server workspace list into local state — the
   * sync hook's initial hydrate step. Local-only fields (`activePaneId`,
   * `pendingPickerPaneId`, pane `pendingPrompt`) are preserved, never overwritten. */
  hydrateFromServer: (machineId: string, workspaces: ServerWorkspaceDTO[]) => void;
  /** Reconciles one incoming `machine-workspace:created`/`:updated` broadcast. */
  applyServerUpsert: (machineId: string, workspace: ServerWorkspaceDTO) => void;
  /** Reconciles an incoming `machine-workspace:deleted` broadcast. */
  applyServerDelete: (machineId: string, workspaceId: string) => void;
  /** Opens an existing session: its own workspace, restored if it already has
   * one, and shown. */
  openTerminal: (machineId: string, scope: OpenTerminalScope) => void;
  /** Split-and-pick's landing step. Returns false when the pane is gone (its
   * workspace closed, the page navigated away) so the caller can clean up the
   * session it just created rather than strand it.
   *
   * `scope` is the FULL session address so the bind-time node-equality
   * assertion has something to check (see `assignPane`); only its narrow half
   * is stored. A scope naming a node other than the workspace's THROWS — that
   * is a caller bug, not the "pane went away" race `false` reports. */
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
  /** Closes a pane, removing its workspace if it was the last one. Returns true
   * in that case, so the caller pushes a DELETE instead of a layout PATCH for a
   * workspace that no longer exists. */
  closePane: (machineId: string, workspaceId: string, paneId: string) => boolean;
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
        // Creates the machine's ENTRY, never a workspace. A machine with zero
        // workspaces is legal (the middle view renders an empty state for it),
        // so fabricating a "Workspace 1" here would resurrect a row the user
        // just removed — and, because this runs from every sidebar tree node,
        // would invent workspaces for machines they never opened.
        //
        // The entry itself must exist even when empty: `applyToMachine` no-ops
        // on a missing machine, so `createWorkspace`/`openTerminal` would
        // silently do nothing without it.
        const machine = get().machines[machineId];
        if (!machine) {
          set((state) => ({
            machines: { ...state.machines, [machineId]: { workspaces: {}, order: [], activeWorkspaceId: '' } },
          }));
          return;
        }

        // Still REPAIRS an active id that doesn't resolve — that renders nothing
        // at all, and there is no way for a user to clear this storage from
        // inside the app, so a blank view would be permanent. The repair is now
        // re-targeting to a workspace that exists (or to "none"), not minting one.
        if (machine.workspaces[machine.activeWorkspaceId]) return;
        set((state) => applyToMachine(state, machineId, (current) => ({
          ...current,
          activeWorkspaceId: current.order[0] ?? '',
        })));
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

      removeWorkspace: (machineId, workspaceId) => {
        set((state) => applyToMachine(state, machineId, (machine) => removeWorkspaceTransition(machine, workspaceId)));
      },

      renameWorkspace: (machineId, workspaceId, name) => {
        set((state) => applyToMachine(state, machineId, (machine) => renameWorkspaceTransition(machine, workspaceId, name)));
      },

      hydrateFromServer: (machineId, workspaces) => {
        set((state) => ({
          machines: { ...state.machines, [machineId]: mergeServerWorkspaces(state.machines[machineId], workspaces) },
        }));
      },

      applyServerUpsert: (machineId, workspace) => {
        set((state) => {
          const machine = state.machines[machineId];
          const next = machine
            ? applyServerWorkspaceUpsert(machine, workspace)
            : mergeServerWorkspaces(undefined, [workspace]);
          return { machines: { ...state.machines, [machineId]: next } };
        });
      },

      applyServerDelete: (machineId, workspaceId) => {
        set((state) => applyToMachine(state, machineId, (machine) => applyServerWorkspaceDeleted(machine, workspaceId)));
      },

      openTerminal: (machineId, scope) => {
        get().ensureMachine(machineId);
        const machine = get().machines[machineId];

        // Is this session already a pane of some workspace? Then that workspace
        // is where it lives, whatever its own id would name. A session spawned by
        // split-and-pick was bound into a pane of the workspace the user was
        // working in, so opening it "in its own workspace" would drag them out of
        // the grid they built it in and leave the same PTY claimed by panes in two
        // workspaces at once. Show it where it actually is.
        const home = workspaceShowing(machine, scope);
        if (home) {
          // The SAME predicate that found the workspace — matching on the name
          // alone would focus the wrong pane the moment a workspace can hold panes
          // from two different nodes.
          const homePaneId = paneShowing(home, scope)?.id;
          set((state) =>
            applyToMachine(state, machineId, (current) =>
              updateWorkspace(setActiveWorkspaceTransition(current, home.id), home.id, (workspace) =>
                homePaneId ? selectPaneTransition(workspace, homePaneId) : workspace
              )
            )
          );
          return;
        }

        const workspaceId = sessionWorkspaceId(scope);

        // Its own workspace exists but the session is not in it: show it as the
        // user last left it — the panes they split into it and the agents in them
        // — and put the session they actually clicked back on screen. They may
        // have closed the pane it was opened in, and without this the row would
        // select a grid that no longer shows the session, with no way back to a
        // PTY that is still running (and billing).
        if (machine.workspaces[workspaceId]) {
          const newPaneId = crypto.randomUUID();
          set((state) =>
            applyToMachine(state, machineId, (current) =>
              updateWorkspace(setActiveWorkspaceTransition(current, workspaceId), workspaceId, (workspace) =>
                showSessionIn(workspace, scope, newPaneId)
              )
            )
          );
          return;
        }

        const workspace = newWorkspace({
          id: workspaceId,
          name: scope.name,
          // The session's node becomes the WORKSPACE's checkout — the single
          // copy of that fact. The pane keeps only the name and surface kind.
          scope: nodeOfTerminalScope(scope),
          firstPaneId: crypto.randomUUID(),
          firstPaneScope: paneScopeOf(scope),
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
        const before = get().machines[machineId];
        if (!before) return false;

        const after = closePaneIn(before, workspaceId, paneId);
        if (after === before) return false;

        set((state) => ({ machines: { ...state.machines, [machineId]: after } }));
        // Reported rather than re-derived by the caller: only the transition
        // knows whether this pane was the workspace's last, and the sync layer
        // must DELETE (not PATCH) when it was.
        return removedWorkspaceBy(before, after, workspaceId);
      },

      selectPane: (machineId, workspaceId, paneId) => {
        set((state) =>
          applyToWorkspace(state, machineId, workspaceId, (workspace) => selectPaneTransition(workspace, paneId))
        );
      },
    }),
    {
      name: 'machine-workspace-storage',
      version: PERSISTED_VERSION,
      // Only the state — the actions are rebuilt on every load. A restored grid
      // reattaches to its PTYs, which is the whole reason to persist it.
      partialize: (state) => ({ machines: state.machines }),

      // What comes out of storage was written by whichever version of this app
      // the user last ran. It is untrusted input, not our own state: a shape this
      // code can't render (a renamed field, a restructured column) would reach
      // `columns.flatMap` and throw during render — and a throw here is a Machine
      // page the user can never open again, with no way to clear this storage
      // from inside the app. So every load is scrubbed down to what is
      // renderable. Losing a stale pane layout is recoverable; the alternative
      // is not.
      //
      // BOTH hooks, on purpose, because zustand runs them on different paths:
      // `merge` runs on EVERY rehydrate (it is the safety net), while `migrate`
      // runs ONLY when the stored version differs from `version` — and if it is
      // absent on that path, zustand logs a console error and hands the old blob
      // to `merge` anyway. They agree by delegating to the same function. A
      // future shape change bumps `version`; it only needs real migration code
      // here if it wants to PRESERVE old state rather than drop it.
      migrate: (persisted) => ({
        machines: sanitizeMachines((persisted as { machines?: unknown } | null)?.machines),
      }),
      merge: (persisted, current) => ({
        ...current,
        machines: sanitizeMachines((persisted as { machines?: unknown } | null)?.machines),
      }),
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

/** Stable empty set — a fresh one per call would hand React a new snapshot on every read. */
const EMPTY_CHILD_SESSIONS: ReadonlySet<string> = new Set<string>();

/**
 * The sessions that are panes INSIDE a workspace rather than workspaces of their
 * own — what the sidebar must not list as separate rows (a split pane belongs to
 * the workspace that owns it). Keyed like `sessionWorkspaceId`, so a caller
 * holding a session's scope can test membership directly.
 */
export const selectChildSessionIds = (machineId: string) => (state: MachineWorkspaceStoreState) => {
  const machine = state.machines[machineId];
  if (!machine) return EMPTY_CHILD_SESSIONS;

  // Cached against the state it was derived FROM. zustand v5 runs the selector
  // inside `getSnapshot`, so one that allocates has to return the same object for
  // the same state — otherwise React sees a new snapshot on every read and the
  // component loops ("The result of getSnapshot should be cached"). The store is
  // immutable, so the state object's identity is an exact cache key: it changes
  // precisely when the answer does. Weak, so a machine's entry dies with it.
  const cached = childSessionCache.get(machine);
  if (cached) return cached;

  const derived = childSessionIds(machine);
  childSessionCache.set(machine, derived);
  return derived;
};

const childSessionCache = new WeakMap<MachineWorkspacesState, ReadonlySet<string>>();

/** How many of a machine's panes are running an agent, optionally at one node's
 * scope — the "N running" count a node shows instead of a session list. */
export const selectRunningPaneCount =
  (machineId: string, scope?: MachineNodeScope) => (state: MachineWorkspaceStoreState) => {
    const machine = state.machines[machineId];
    return machine ? runningPaneCount(machine, scope) : 0;
  };
