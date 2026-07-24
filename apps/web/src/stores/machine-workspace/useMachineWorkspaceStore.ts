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
  updateWorkspace,
  workspaceShowing,
  sanitizeMachines,
  mergeServerWorkspaces,
  applyServerWorkspaceUpsert,
  applyServerWorkspaceDeleted,
  sessionWorkspaceId,
  nextWorkspaceName,
  setActiveWorkspace as setActiveWorkspaceTransition,
  assignPane as assignPaneTransition,
  clearPanePrompt as clearPanePromptTransition,
  restorePanePendingPrompt,
  dismissPicker as dismissPickerTransition,
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
import { applyVerbLocal, type WorkspaceVerb } from './workspace-verbs';

export type { WorkspaceVerb };

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
  /** The last server rev this browser has applied, per machine (#2202) — `0`
   * for a machine never snapshotted/verb-applied yet. Gates `applyServerSnapshot`/
   * `applyServerVerb`: a payload at or behind this rev is stale and dropped. */
  serverRev: Record<string, number>;
  /** Verbs this browser has applied locally (optimistically) but not yet had
   * confirmed by the server, per machine (#2202) — re-applied on top of every
   * incoming snapshot/verb so an in-flight local change is never visibly
   * clobbered by another browser's echo landing first. Removed by `settleVerb`
   * once the pushing browser's own POST resolves (or is abandoned on failure). */
  pendingVerbs: Record<string, WorkspaceVerb[]>;
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
  /**
   * Rev-gated full-snapshot replace (#2202) — `GET /api/machines/workspaces`'s
   * successor to the once-per-mount `hydrateFromServer`. Safe to call on EVERY
   * revalidation (reconnect, focus, a second mounted instance's own fetch):
   * a `rev` at or behind what this browser already has is simply discarded,
   * so there is no "only the first hydrate counts" ordering to protect. Any
   * still-`pendingVerbs` are re-applied on top of the fresh server state.
   */
  applyServerSnapshot: (machineId: string, rev: number, workspaces: ServerWorkspaceDTO[]) => void;
  /**
   * Rev-gated single-workspace upsert/delete (#2202) — `machine-workspace:verb`'s
   * handler. `workspace: null` means the verb removed it. A `rev` at or behind
   * what this browser already has is a duplicate/stale delivery and dropped;
   * the payload is self-contained (a full post-verb snapshot of the ONE
   * workspace the verb touched), so out-of-order delivery between machines'
   * verbs never corrupts state — only a genuine gap (`rev` more than one past
   * what's applied) needs a caller-triggered `applyServerSnapshot` refetch.
   * Any still-`pendingVerbs` are re-applied on top.
   */
  applyServerVerb: (machineId: string, payload: { rev: number; workspaceId: string; workspace: ServerWorkspaceDTO | null }) => void;
  /** Removes one verb from `pendingVerbs` once its own push has settled
   * (succeeded or been abandoned) — by reference, not content, since two
   * structurally-identical verbs pushed back to back are still two distinct
   * in-flight operations. */
  settleVerb: (machineId: string, verb: WorkspaceVerb) => void;
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

/**
 * Applies one {@link WorkspaceVerb} through {@link applyVerbLocal} — the SAME
 * function the server's verb engine (`workspace-verbs-runtime.ts`) and the AI
 * planner (`session-layout.ts`) use — and, iff it actually applied, queues it
 * onto `pendingVerbs` for the sync layer to push and for later rebase (#2202).
 * A verb whose target doesn't resolve (unknown workspace/pane) is a pure
 * no-op: no state change, nothing queued, matching every other transition
 * here.
 */
function applyVerbAndQueue(
  set: (fn: (state: MachineWorkspaceStoreState) => Partial<MachineWorkspaceStoreState>) => void,
  get: () => MachineWorkspaceStoreState,
  machineId: string,
  verb: WorkspaceVerb
): ReturnType<typeof applyVerbLocal> {
  const machine = get().machines[machineId] ?? { workspaces: {}, order: [], activeWorkspaceId: '' };
  const outcome = applyVerbLocal(machine, verb);
  if (!outcome.applied) return outcome;

  set((state) => ({
    machines: { ...state.machines, [machineId]: outcome.state },
    pendingVerbs: { ...state.pendingVerbs, [machineId]: [...(state.pendingVerbs[machineId] ?? []), verb] },
  }));
  return outcome;
}

/** Every pane's `pendingPrompt`, before a rebase — see `rebasePendingVerbs`.
 * Keyed by pane id (unique within a machine's grids in practice: split-and-
 * pick mints pane ids with `crypto.randomUUID()`), holding enough to find
 * the pane again after the rebase and restore it. */
function collectPendingPrompts(machine: MachineWorkspacesState): { workspaceId: string; paneId: string; pendingPrompt: string }[] {
  const prompts: { workspaceId: string; paneId: string; pendingPrompt: string }[] = [];
  for (const workspace of workspacesOf(machine)) {
    for (const pane of panesOf(workspace)) {
      if (pane.pendingPrompt !== undefined) {
        prompts.push({ workspaceId: workspace.id, paneId: pane.id, pendingPrompt: pane.pendingPrompt });
      }
    }
  }
  return prompts;
}

/**
 * Re-applies every still-pending local verb on top of freshly-arrived server
 * truth (a snapshot or another workspace's verb echo) — shared by
 * `applyServerSnapshot`/`applyServerVerb`. An in-flight local change (e.g. a
 * bind whose POST hasn't resolved yet) must never be visibly undone by an
 * unrelated update landing first.
 *
 * `pendingPrompt` needs its OWN restore pass around that replay:
 * `WorkspaceVerb` carries no `pendingPrompt` field (it's local-only, never
 * on the wire — see `workspace-verbs.ts`'s module doc), so replaying a
 * pending `bind-pane` verb through `applyVerbLocal` re-binds the pane's
 * scope correctly but leaves `pendingPrompt` cleared, silently dropping a
 * starting prompt that just hadn't been typed into the PTY yet. Captured
 * before the replay and restored after, onto whichever pane still resolves —
 * a verb never legitimately changes `pendingPrompt` itself, so anything a
 * pane had beforehand must still hold it afterward.
 */
function rebasePendingVerbs(state: MachineWorkspaceStoreState, machineId: string, machine: MachineWorkspacesState): MachineWorkspacesState {
  const pendingVerbs = state.pendingVerbs[machineId] ?? [];
  if (pendingVerbs.length === 0) return machine;

  const prompts = collectPendingPrompts(machine);
  let next = machine;
  for (const verb of pendingVerbs) {
    next = applyVerbLocal(next, verb).state;
  }
  for (const { workspaceId, paneId, pendingPrompt } of prompts) {
    next = updateWorkspace(next, workspaceId, (workspace) => restorePanePendingPrompt(workspace, paneId, pendingPrompt));
  }
  return next;
}

export const useMachineWorkspaceStore = create<MachineWorkspaceStoreState>()(
  persist(
    (set, get) => ({
      machines: {},
      serverRev: {},
      pendingVerbs: {},

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
        const workspaceId = crypto.randomUUID();
        applyVerbAndQueue(set, get, machineId, {
          type: 'create-workspace',
          workspaceId,
          name: nextWorkspaceName(machine),
          scope: nodeScopeNames(scope),
          firstPaneId: crypto.randomUUID(),
          session: null,
        });
        return workspaceId;
      },

      setActiveWorkspace: (machineId, workspaceId) => {
        set((state) => applyToMachine(state, machineId, (machine) => setActiveWorkspaceTransition(machine, workspaceId)));
      },

      removeWorkspace: (machineId, workspaceId) => {
        applyVerbAndQueue(set, get, machineId, { type: 'remove-workspace', workspaceId });
      },

      renameWorkspace: (machineId, workspaceId, name) => {
        applyVerbAndQueue(set, get, machineId, { type: 'rename-workspace', workspaceId, name });
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

      applyServerSnapshot: (machineId, rev, workspaces) => {
        set((state) => {
          if ((state.serverRev[machineId] ?? 0) > rev) return state; // stale — discard
          const merged = mergeServerWorkspaces(state.machines[machineId], workspaces);
          return {
            machines: { ...state.machines, [machineId]: rebasePendingVerbs(state, machineId, merged) },
            serverRev: { ...state.serverRev, [machineId]: rev },
          };
        });
      },

      applyServerVerb: (machineId, payload) => {
        set((state) => {
          if ((state.serverRev[machineId] ?? 0) >= payload.rev) return state; // duplicate/stale echo — discard
          const current = state.machines[machineId] ?? { workspaces: {}, order: [], activeWorkspaceId: '' };
          const upserted = payload.workspace
            ? applyServerWorkspaceUpsert(current, payload.workspace)
            : applyServerWorkspaceDeleted(current, payload.workspaceId);
          return {
            machines: { ...state.machines, [machineId]: rebasePendingVerbs(state, machineId, upserted) },
            serverRev: { ...state.serverRev, [machineId]: payload.rev },
          };
        });
      },

      settleVerb: (machineId, verb) => {
        set((state) => {
          const pending = state.pendingVerbs[machineId];
          if (!pending) return state;
          const index = pending.indexOf(verb);
          if (index === -1) return state;
          return {
            pendingVerbs: { ...state.pendingVerbs, [machineId]: [...pending.slice(0, index), ...pending.slice(index + 1)] },
          };
        });
      },

      openTerminal: (machineId, scope) => {
        get().ensureMachine(machineId);
        const machine = get().machines[machineId];
        const session = paneScopeOf(scope);

        // Is this session already a pane of some workspace, or does its own
        // deterministic workspace already exist? Either way it has a HOME —
        // `add-pane` is the server-side `showSessionIn`: focus the pane already
        // showing it, fill an empty pane, or split a new one. A session spawned
        // by split-and-pick was bound into a pane of the workspace the user was
        // working in, so opening it "in its own workspace" would drag them out
        // of the grid they built it in and leave the same PTY claimed by panes
        // in two workspaces at once — `workspaceShowing` is checked FIRST so
        // that home wins over the derived id.
        const home = workspaceShowing(machine, scope);
        const workspaceId = home ? home.id : sessionWorkspaceId(scope);

        if (home || machine.workspaces[workspaceId]) {
          applyVerbAndQueue(set, get, machineId, { type: 'add-pane', workspaceId, newPaneId: crypto.randomUUID(), session });
          set((state) => applyToMachine(state, machineId, (current) => setActiveWorkspaceTransition(current, workspaceId)));
          return;
        }

        // Born bound: the session's node becomes the WORKSPACE's checkout (the
        // single copy of that fact) and the pane keeps only the name and surface kind.
        applyVerbAndQueue(set, get, machineId, {
          type: 'create-workspace',
          workspaceId,
          name: scope.name,
          scope: nodeScopeNames(nodeOfTerminalScope(scope)),
          firstPaneId: crypto.randomUUID(),
          session,
        });
      },

      bindPaneTerminal: (machineId, workspaceId, paneId, scope, pendingPrompt) => {
        const workspace = get().machines[machineId]?.workspaces[workspaceId];
        if (!workspace) return false;
        // Bind-time node equality — a pane's checkout is its workspace's. A
        // scope naming a DIFFERENT node is a caller bug (a spawn addressed at
        // the wrong node), not the "pane is gone" race `false` reports, so it
        // throws rather than silently binding under the workspace's checkout.
        // Checked HERE, before the verb: `WorkspaceVerb`'s `SessionRef` carries
        // no checkout at all (see workspace-verbs.ts's module doc), so the verb
        // path itself can't detect a mismatch — it always binds at the
        // workspace's own node by construction.
        if (!isSameNodeScope(nodeOfTerminalScope(scope), workspace.scope)) {
          throw new Error(
            `Cannot bind session "${scope.name}" into workspace "${workspaceId}" at a different node — a pane's checkout is its workspace's`
          );
        }

        const outcome = applyVerbAndQueue(set, get, machineId, { type: 'bind-pane', workspaceId, paneId, session: paneScopeOf(scope) });
        // `pendingPrompt` is LOCAL-ONLY (see assignPane's doc) — it never
        // crosses the wire, so the verb above can't carry it. Re-applying
        // `assignPane` directly (not queued as a second verb) sets it on the
        // same pane the verb just bound, purely as local optimistic UI state.
        if (outcome.applied && pendingPrompt !== undefined) {
          set((state) => applyToWorkspace(state, machineId, workspaceId, (workspace) => assignPaneTransition(workspace, paneId, scope, pendingPrompt)));
        }
        return outcome.applied;
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
        applyVerbAndQueue(set, get, machineId, { type: 'split-pane', workspaceId, fromPaneId, direction: 'right', newColumnId, newPaneId });
      },

      splitDown: (machineId, workspaceId, fromPaneId) => {
        const newPaneId = crypto.randomUUID();
        applyVerbAndQueue(set, get, machineId, { type: 'split-pane', workspaceId, fromPaneId, direction: 'down', newPaneId });
      },

      closePane: (machineId, workspaceId, paneId) => {
        const outcome = applyVerbAndQueue(set, get, machineId, { type: 'close-pane', workspaceId, paneId });
        // Reported rather than re-derived by the caller: only the transition
        // knows whether this pane was the workspace's last, and the sync layer
        // must DELETE (not PATCH) when it was.
        return outcome.removedWorkspaceId !== undefined;
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
