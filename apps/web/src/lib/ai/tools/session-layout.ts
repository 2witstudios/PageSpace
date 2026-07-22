/**
 * Session MANIFESTATION planning — where a session shows up on screen.
 *
 * A session is two facts: a `machine_agent_terminals` row (its identity and
 * sandbox), and its MANIFESTATION — the pane(s) of the machine's workspaces
 * that render it. The session family's tools (`add_session`, `move_session`,
 * `kill_session`) all mutate the second half, and this module is the ONE place
 * that decides what those mutations look like.
 *
 * It writes NO new layout rules. Every transition here is the phase-1 CLIENT
 * reducer (`@/stores/machine-workspace/workspace-reducer`) applied to a
 * server-loaded view list: `newWorkspace`/`addWorkspace` for a born-bound
 * view, `splitRight`/`splitDown` + `assignPane` for a split, `closePaneIn`
 * for a kill. That is deliberate and load-bearing — the server is now a SECOND
 * writer of the same layout blob the browser writes (the phase-4 exit
 * criterion: #2202 becomes the entity-promotion successor), so the only
 * defensible way to keep the two byte-identical is to run the same code. A
 * server-side re-implementation would drift on its first bug fix.
 *
 * The plan is expressed as WRITES (create / update / remove) rather than a new
 * layout blob, because that is exactly the shape of the three existing
 * persistence + broadcast paths (`POST`/`PATCH`/`DELETE /api/machines/
 * workspaces`): a caller applies them through the same service functions the
 * human UI already goes through, so both writers converge on one row set and
 * one broadcast vocabulary.
 */

import {
  addWorkspace,
  assignPane,
  closePaneIn,
  isSameNodeScope,
  machineNodeScope,
  newWorkspace,
  nodeOfTerminalScope,
  nodeScopeNames,
  paneScopeOf,
  paneShowing,
  projectStoredPaneScope,
  showSessionIn,
  sessionWorkspaceId,
  splitDown,
  splitRight,
  updateWorkspace,
  workspacesOf,
  workspaceShowing,
  type MachineWorkspacesState,
  type OpenTerminalScope,
  type PaneSessionScope,
  type TerminalColumnState,
  type WorkspaceState,
} from '@/stores/machine-workspace/workspace-reducer';

/** One pane as it crosses the wire — the client's `toWireColumns` shape. */
export interface WirePane {
  id: string;
  scope: PaneSessionScope | null;
}

export interface WireColumn {
  id: string;
  panes: WirePane[];
}

/**
 * A machine's stored VIEW (a `machine_workspaces` row), narrowed to what
 * layout planning needs. `projectName`/`branchName` are the stored node
 * columns — the discriminant is re-derived here (`machineNodeScope`) exactly
 * as the client re-derives it on the way in, so the two can never disagree.
 */
export interface SessionView {
  id: string;
  name: string;
  projectName: string | null;
  branchName: string | null;
  columns: WireColumn[];
}

/** One persistence step: create a row, replace a row's layout, or drop a row. */
export type SessionViewWrite =
  | { kind: 'create'; id: string; name: string; scope: { projectName?: string; branchName?: string }; columns: WireColumn[] }
  | { kind: 'update'; id: string; columns: WireColumn[] }
  | { kind: 'remove'; id: string };

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
  | { ok: true; writes: SessionViewWrite[]; viewId: string }
  /** `splitInto` named a view this machine doesn't have. */
  | { ok: false; reason: 'view_not_found' }
  /** `splitInto` named a view at a DIFFERENT node — a pane's checkout is its view's. */
  | { ok: false; reason: 'cross_node' };

/** Strips local-only pane state before a layout crosses the wire — the server's copy of `useMachineWorkspaceSync`'s own helper. */
export function toWireColumns(columns: TerminalColumnState[]): WireColumn[] {
  return columns.map((column) => ({
    id: column.id,
    panes: column.panes.map((pane) => ({ id: pane.id, scope: pane.scope })),
  }));
}

/** A stored view as the reducer sees it. Local-only fields are defaulted, never persisted back. */
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

/**
 * The writes that carry `before` to `after`. Ordered removes-then-creates-
 * then-updates is deliberately NOT imposed: the writes are emitted in the
 * order a caller should apply them — removals first (so a moved session never
 * exists in two places, even briefly, for a browser applying the broadcasts in
 * order), then the rest.
 */
function diffViews(before: MachineWorkspacesState, after: MachineWorkspacesState): SessionViewWrite[] {
  const removes: SessionViewWrite[] = [];
  const rest: SessionViewWrite[] = [];

  for (const id of before.order) {
    if (!after.workspaces[id]) removes.push({ kind: 'remove', id });
  }

  for (const workspace of workspacesOf(after)) {
    const previous = before.workspaces[workspace.id];
    const columns = toWireColumns(workspace.columns);
    if (!previous) {
      rest.push({
        kind: 'create',
        id: workspace.id,
        name: workspace.name,
        scope: nodeScopeNames(workspace.scope),
        columns,
      });
      continue;
    }
    const previousColumns = toWireColumns(previous.columns);
    if (JSON.stringify(previousColumns) !== JSON.stringify(columns)) {
      rest.push({ kind: 'update', id: workspace.id, columns });
    }
  }

  return [...removes, ...rest];
}

/**
 * THE placement writer. `add_session` uses it to materialize a brand-new
 * session; `move_session` re-uses it verbatim after closing the session's old
 * manifestations, which is why re-homing needs no layout code of its own.
 *
 * `'new-view'` mirrors the client's `openTerminal` exactly, including its
 * branches: a session already shown somewhere stays there, a session whose own
 * (deterministic) view still exists is shown INSIDE it rather than duplicated,
 * and only a session with no home at all gets a fresh born-bound view.
 */
function placeSession(
  state: MachineWorkspacesState,
  scope: OpenTerminalScope,
  placement: SessionPlacement,
  ids: SessionPlacementIds,
): { ok: true; state: MachineWorkspacesState; viewId: string } | { ok: false; reason: 'view_not_found' | 'cross_node' } {
  if (placement === 'new-view') {
    const showing = workspaceShowing(state, scope);
    if (showing) {
      return { ok: true, state: updateWorkspace(state, showing.id, (workspace) => showSessionIn(workspace, scope, ids.paneId)), viewId: showing.id };
    }

    const viewId = sessionWorkspaceId(scope);
    if (state.workspaces[viewId]) {
      return { ok: true, state: updateWorkspace(state, viewId, (workspace) => showSessionIn(workspace, scope, ids.paneId)), viewId };
    }

    // Born bound: the session's node becomes the VIEW's checkout (the single
    // copy of that fact) and the pane keeps only the name and surface kind.
    const workspace = newWorkspace({
      id: viewId,
      name: scope.name,
      scope: nodeOfTerminalScope(scope),
      firstPaneId: ids.paneId,
      firstPaneScope: paneScopeOf(scope),
    });
    return { ok: true, state: addWorkspace(state, workspace), viewId };
  }

  const view = state.workspaces[placement.splitInto];
  if (!view) return { ok: false, reason: 'view_not_found' };
  // A pane's checkout is its view's, so a session can only be shown in a view
  // at its own node. Refusing here (rather than letting `assignPane`'s
  // bind-time assertion throw) is what makes a cross-node placement a tool
  // denial the model can act on.
  if (!isSameNodeScope(view.scope, nodeOfTerminalScope(scope))) return { ok: false, reason: 'cross_node' };

  return {
    ok: true,
    viewId: view.id,
    state: updateWorkspace(state, view.id, (workspace) => {
      const split =
        placement.direction === 'right'
          ? splitRight(workspace, workspace.activePaneId, ids.columnId, ids.paneId)
          : splitDown(workspace, workspace.activePaneId, ids.paneId);
      return assignPane(split, ids.paneId, scope);
    }),
  };
}

/** Every pane of every view that currently renders this session, closed — the kill-manifestation half. */
function closeSession(state: MachineWorkspacesState, scope: OpenTerminalScope): MachineWorkspacesState {
  let next = state;
  // Re-read the workspace list each round: closing a view's last pane removes
  // the view itself, so iterating a snapshot would address rows that are gone.
  for (;;) {
    const workspace = workspacesOf(next).find((candidate) => paneShowing(candidate, scope) !== undefined);
    if (!workspace) return next;
    const pane = paneShowing(workspace, scope);
    if (!pane) return next;
    const after = closePaneIn(next, workspace.id, pane.id);
    // `closePaneIn` returns its input when nothing changed; without this the
    // loop above would spin forever on a pane it cannot close.
    if (after === next) return next;
    next = after;
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
  return { ok: true, writes: diffViews(before, placed.state), viewId: placed.viewId };
}

/** Plan the removal of every manifestation of a session (`kill_session`). */
export function planCloseSession(views: SessionView[], scope: OpenTerminalScope): SessionViewWrite[] {
  const before = toMachineState(views);
  return diffViews(before, closeSession(before, scope));
}

/**
 * Plan a re-home: close every existing manifestation, then run the SAME
 * placement writer `add_session` uses. Composed, not re-implemented — the
 * epic's rule is that a move introduces no second layout writer.
 *
 * Closing FIRST is what keeps the destination honest: a session whose old view
 * held nothing else is removed by the close, so the placement sees the same
 * world a fresh `add_session` would, and the new pane is a brand-new pane id
 * bound IN THE SAME WRITE — never an unbound pane that a later echo has to
 * repair (the monotone merge guard's null→bound invariant is preserved by
 * construction).
 */
export function planMoveSession(
  views: SessionView[],
  scope: OpenTerminalScope,
  placement: SessionPlacement,
  ids: SessionPlacementIds,
): SessionLayoutPlan {
  const before = toMachineState(views);
  const closed = closeSession(before, scope);
  const placed = placeSession(closed, scope, placement, ids);
  if (!placed.ok) return placed;
  return { ok: true, writes: diffViews(before, placed.state), viewId: placed.viewId };
}

/** Whether any of a machine's views currently renders this session — used to report a move's no-op honestly. */
export function isSessionManifested(views: SessionView[], scope: OpenTerminalScope): boolean {
  const state = toMachineState(views);
  return workspacesOf(state).some((workspace) => paneShowing(workspace, scope) !== undefined);
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
