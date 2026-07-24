/**
 * Session MANIFESTATION planning — where a session shows up on screen.
 *
 * A session is two facts: a `machine_agent_terminals` row (its identity and
 * sandbox), and its MANIFESTATION — the pane(s) of the machine's workspaces
 * that render it. The session family's tools (`add_session`, `move_session`,
 * `kill_session`) all mutate the second half, and this module is the ONE place
 * that decides what those mutations look like.
 *
 * #2202 (entity promotion): this module used to run the client reducer
 * server-side and diff before/after state into `SessionViewWrite`s, because
 * the server was a SECOND writer of the same layout blob the browser wrote —
 * the only defensible way to keep two independent writers byte-identical was
 * to run the same code. That reasoning is now structural rather than a
 * convention: every placement/close decision here is expressed as a
 * {@link WorkspaceVerb} from `@/stores/machine-workspace/workspace-verbs`, and
 * `applyVerbLocal` — the SAME function the client's optimistic apply and the
 * HTTP verb route both call — is used here too, purely to SIMULATE what a
 * verb would do so the next decision (does this session already have a home,
 * is a pane still open to close) sees the right state. The actual persistence
 * happens once, in `session-tools-runtime.ts`, through the identical
 * `applyWorkspaceVerb` engine `POST /api/machines/workspaces/verbs` uses —
 * there is only one write path left, not two writers of one blob.
 */

import {
  isSameNodeScope,
  machineNodeScope,
  nodeOfTerminalScope,
  nodeScopeNames,
  paneScopeOf,
  paneShowing,
  projectStoredPaneScope,
  sessionWorkspaceId,
  workspacesOf,
  workspaceShowing,
  type MachineWorkspacesState,
  type OpenTerminalScope,
  type PaneSessionScope,
  type TerminalColumnState,
  type WorkspaceState,
} from '@/stores/machine-workspace/workspace-reducer';
import { applyVerbLocal, type SessionRef, type WorkspaceVerb } from '@/stores/machine-workspace/workspace-verbs';

/** One pane as it crosses the wire — structurally identical to
 * `WorkspaceGridPaneRecord` (`machine-panes-store.ts`); named locally so this
 * module doesn't need a `packages/lib` import for a shape it only reads. */
export interface WirePane {
  id: string;
  scope: PaneSessionScope | null;
}

export interface WireColumn {
  id: string;
  panes: WirePane[];
}

/**
 * A machine's stored VIEW (a `machine_workspaces` row + its relational grid),
 * narrowed to what layout planning needs. `projectName`/`branchName` are the
 * stored node columns — the discriminant is re-derived here
 * (`machineNodeScope`) exactly as the client re-derives it on the way in, so
 * the two can never disagree.
 */
export interface SessionView {
  id: string;
  name: string;
  projectName: string | null;
  branchName: string | null;
  columns: WireColumn[];
}

/**
 * Where a session should MATERIALIZE. `'new-view'` gives it its own
 * (deterministically-identified) view — the born-bound case; `{ splitInto }`
 * puts it in an existing view, addressed by the workspace id `list_sessions`
 * reports.
 */
export type SessionPlacement = 'new-view' | { splitInto: string; direction: 'right' | 'down' };

/** Ids the caller mints (this module stays pure/deterministic — same rule as the client reducer). */
export interface SessionPlacementIds {
  paneId: string;
  columnId: string;
}

export type SessionLayoutPlan =
  | { ok: true; verbs: WorkspaceVerb[]; viewId: string }
  /** `splitInto` named a view this machine doesn't have. */
  | { ok: false; reason: 'view_not_found' }
  /** `splitInto` named a view at a DIFFERENT node — a pane's checkout is its view's. */
  | { ok: false; reason: 'cross_node' };

/** A stored view as the reducer sees it — used only to answer READ questions
 * (is this session already shown, does a named view exist, what's its scope)
 * before a verb is chosen. Local-only fields are defaulted, never persisted. */
function toWorkspaceState(view: SessionView): WorkspaceState {
  const columns: TerminalColumnState[] = view.columns.map((column) => ({
    id: column.id,
    // Same read-time projection every client merge path applies: a row written
    // by a pre-narrowing client still carries the checkout per pane.
    panes: column.panes.map((pane) => ({ id: pane.id, scope: projectStoredPaneScope(pane.scope) })),
  }));
  const paneIds = columns.flatMap((column) => column.panes.map((pane) => pane.id));
  return {
    id: view.id,
    name: view.name,
    scope: machineNodeScope({
      ...(view.projectName ? { projectName: view.projectName } : {}),
      ...(view.branchName ? { branchName: view.branchName } : {}),
    }),
    columns,
    // Deterministic anchor: the server has no notion of "the pane the user is
    // looking at", and every grid transition no-ops on a pane id it cannot
    // resolve, so a split must anchor on one that certainly exists.
    activePaneId: paneIds[0] ?? '',
    pendingPickerPaneId: null,
  };
}

function toMachineState(views: SessionView[]): MachineWorkspacesState {
  const workspaces: Record<string, WorkspaceState> = {};
  const order: string[] = [];
  for (const view of views) {
    workspaces[view.id] = toWorkspaceState(view);
    order.push(view.id);
  }
  return { workspaces, order, activeWorkspaceId: '' };
}

function sessionRefOf(scope: OpenTerminalScope): SessionRef {
  return paneScopeOf(scope);
}

/**
 * THE placement decision. `add_session` uses it to materialize a brand-new
 * session; `move_session` re-uses it verbatim after closing the session's old
 * manifestations, which is why re-homing needs no layout code of its own.
 *
 * `'new-view'` mirrors the client's `openTerminal` exactly, including its
 * branches: a session already shown somewhere (or whose own deterministic
 * view already exists) is shown there via `add-pane` (server-side
 * `showSessionIn`), and only a session with no home at all gets a fresh
 * `create-workspace`, born-bound.
 */
function placeSession(
  state: MachineWorkspacesState,
  scope: OpenTerminalScope,
  placement: SessionPlacement,
  ids: SessionPlacementIds,
): { ok: true; verb: WorkspaceVerb; viewId: string } | { ok: false; reason: 'view_not_found' | 'cross_node' } {
  const session = sessionRefOf(scope);

  if (placement === 'new-view') {
    const showing = workspaceShowing(state, scope);
    if (showing) {
      return { ok: true, verb: { type: 'add-pane', workspaceId: showing.id, newPaneId: ids.paneId, session }, viewId: showing.id };
    }

    const viewId = sessionWorkspaceId(scope);
    if (state.workspaces[viewId]) {
      return { ok: true, verb: { type: 'add-pane', workspaceId: viewId, newPaneId: ids.paneId, session }, viewId };
    }

    // Born bound: the session's node becomes the VIEW's checkout (the single
    // copy of that fact) and the pane keeps only the name and surface kind.
    return {
      ok: true,
      viewId,
      verb: {
        type: 'create-workspace',
        workspaceId: viewId,
        name: scope.name,
        scope: nodeScopeNames(nodeOfTerminalScope(scope)),
        firstPaneId: ids.paneId,
        session,
      },
    };
  }

  const view = state.workspaces[placement.splitInto];
  if (!view) return { ok: false, reason: 'view_not_found' };
  // A pane's checkout is its view's, so a session can only be shown in a view
  // at its own node. Refusing here (rather than letting the verb engine's
  // bind-time assertion throw) is what makes a cross-node placement a tool
  // denial the model can act on.
  if (!isSameNodeScope(view.scope, nodeOfTerminalScope(scope))) return { ok: false, reason: 'cross_node' };

  return {
    ok: true,
    viewId: view.id,
    verb: {
      type: 'split-pane',
      workspaceId: view.id,
      fromPaneId: view.activePaneId,
      direction: placement.direction,
      newColumnId: ids.columnId,
      newPaneId: ids.paneId,
      session,
    },
  };
}

/** Every pane of every view that currently renders this session, closed — the
 * kill-manifestation half. Returns the ordered `close-pane` verbs AND which
 * workspace ids they removed entirely (a close-pane that empties a view's
 * last pane takes the view with it) — `kill_session`'s `closedViews` count
 * needs the latter, not just "how many panes closed". */
function closeSession(state: MachineWorkspacesState, scope: OpenTerminalScope): { verbs: WorkspaceVerb[]; state: MachineWorkspacesState; closedWorkspaceIds: string[] } {
  const verbs: WorkspaceVerb[] = [];
  const closedWorkspaceIds: string[] = [];
  let current = state;
  // Re-read the workspace list each round: closing a view's last pane removes
  // the view itself, so iterating a snapshot would address rows that are gone.
  for (;;) {
    const workspace = workspacesOf(current).find((candidate) => paneShowing(candidate, scope) !== undefined);
    if (!workspace) return { verbs, state: current, closedWorkspaceIds };
    const pane = paneShowing(workspace, scope);
    if (!pane) return { verbs, state: current, closedWorkspaceIds };

    const verb: WorkspaceVerb = { type: 'close-pane', workspaceId: workspace.id, paneId: pane.id };
    const outcome = applyVerbLocal(current, verb);
    // `applied: false` means the pane didn't resolve — shouldn't happen given
    // `paneShowing` just found it, but mirrors the old no-op guard rather than
    // spinning forever.
    if (!outcome.applied) return { verbs, state: current, closedWorkspaceIds };

    verbs.push(verb);
    if (outcome.removedWorkspaceId) closedWorkspaceIds.push(outcome.removedWorkspaceId);
    current = outcome.state;
  }
}

/** Plan the placement of a session that has no manifestation yet (`add_session`). */
export function planPlaceSession(
  views: SessionView[],
  scope: OpenTerminalScope,
  placement: SessionPlacement,
  ids: SessionPlacementIds,
): SessionLayoutPlan {
  const before = toMachineState(views);
  const placed = placeSession(before, scope, placement, ids);
  if (!placed.ok) return placed;
  return { ok: true, verbs: [placed.verb], viewId: placed.viewId };
}

/** Plan the removal of every manifestation of a session (`kill_session`). */
export function planCloseSession(views: SessionView[], scope: OpenTerminalScope): { verbs: WorkspaceVerb[]; closedWorkspaceIds: string[] } {
  const before = toMachineState(views);
  const { verbs, closedWorkspaceIds } = closeSession(before, scope);
  return { verbs, closedWorkspaceIds };
}

/**
 * Plan a re-home: close every existing manifestation, then run the SAME
 * placement decision `add_session` uses. Composed, not re-implemented — the
 * epic's rule is that a move introduces no second layout writer.
 *
 * Closing FIRST is what keeps the destination honest: a session whose old view
 * held nothing else is removed by the close, so the placement sees the same
 * world a fresh `add_session` would, and the new pane is a brand-new pane id
 * bound IN THE SAME VERB — never an unbound pane a later echo has to repair.
 */
export function planMoveSession(
  views: SessionView[],
  scope: OpenTerminalScope,
  placement: SessionPlacement,
  ids: SessionPlacementIds,
): SessionLayoutPlan {
  const before = toMachineState(views);
  const { verbs: closeVerbs, state: closed } = closeSession(before, scope);
  const placed = placeSession(closed, scope, placement, ids);
  if (!placed.ok) return placed;
  return { ok: true, verbs: [...closeVerbs, placed.verb], viewId: placed.viewId };
}

/** The views that hang under one node, as `list_sessions` reports them. */
export function viewsAtNode(views: SessionView[], names: { projectName?: string; branchName?: string }): SessionView[] {
  const node = machineNodeScope(names);
  return views.filter((view) =>
    isSameNodeScope(
      machineNodeScope({
        ...(view.projectName ? { projectName: view.projectName } : {}),
        ...(view.branchName ? { branchName: view.branchName } : {}),
      }),
      node,
    ),
  );
}
