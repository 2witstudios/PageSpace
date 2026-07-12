/**
 * Machine Workspace — functional core.
 *
 * Pure, framework-free state transitions for the Machine page's middle view.
 * IDs are passed in rather than generated here, so every transition is
 * deterministic and independently testable.
 *
 * THE MODEL (PurePoint-exact): a **workspace** is a sidebar item that OWNS a
 * pane grid. A machine holds MANY workspaces and exactly one is active; the
 * middle view always renders the active workspace's grid, so selecting a
 * different workspace switches the WHOLE middle view to that item's combination
 * of terminals. (What it replaces: one grid per machine, where opening a
 * terminal only overwrote the active pane and the view never really switched.)
 *
 * Two levels, therefore two kinds of transition here:
 *   - grid-level  (WorkspaceState): the existing two-level column/pane split —
 *     a horizontal row of columns, each an independent vertical stack of panes.
 *     Deliberately NOT a recursive split tree. splitRight adds a column;
 *     splitDown stacks within one. Unchanged, now applied PER workspace.
 *   - machine-level (MachineWorkspacesState): which workspaces exist, their
 *     order, and which one is active.
 */

/** Identifies which terminal to open in a pane — neither `projectName` nor
 * `branchName` set is machine scope, `projectName` alone is project scope,
 * both is branch scope. */
export interface OpenTerminalScope {
  projectName?: string;
  branchName?: string;
  name: string;
}

/**
 * The node container a workspace lives under — an {@link OpenTerminalScope}
 * minus the session name. Nodes are STRUCTURE, not the grid-owning unit: a
 * workspace's scope says which checkout its panes' agents run in (a branch
 * scope = that branch's working tree), while the grid itself belongs to the
 * workspace.
 */
export interface MachineNodeScope {
  projectName?: string;
  branchName?: string;
}

/** The Machine node itself (neither project nor branch). A shared constant so
 * callers can hand out a stable default without a new object per render. */
export const MACHINE_NODE_SCOPE: MachineNodeScope = Object.freeze({});

/** The node a session lives under — a session's scope IS a node plus a name. */
export function nodeOfTerminalScope(scope: OpenTerminalScope): MachineNodeScope {
  return { projectName: scope.projectName, branchName: scope.branchName };
}

export function isSameNodeScope(a: MachineNodeScope, b: MachineNodeScope): boolean {
  return (a.projectName ?? '') === (b.projectName ?? '') && (a.branchName ?? '') === (b.branchName ?? '');
}

export interface TerminalPaneState {
  id: string;
  scope: OpenTerminalScope | null;
  /** Typed into the agent's PTY once it's ready, then cleared — a pane that
   * re-mounts (tab switch, reattach) must not re-send the starting prompt. */
  pendingPrompt?: string;
}

export interface TerminalColumnState {
  id: string;
  panes: TerminalPaneState[];
}

/** One sidebar item's pane grid. */
export interface WorkspaceState {
  id: string;
  /** Auto-named — the user is never asked. Shown in the sidebar by sub-task 3. */
  name: string;
  /** The node container this workspace hangs under; every agent spawned into
   * one of its panes runs in this scope's checkout. */
  scope: MachineNodeScope;
  columns: TerminalColumnState[];
  activePaneId: string;
  /** The empty pane whose inline agent picker should take focus — set when a
   * split makes a new pane, so the user lands in the picker instead of staring
   * at a blank pane. Cleared once that pane is filled or the picker is left. */
  pendingPickerPaneId: string | null;
}

/** Every workspace of one machine, plus which one the middle view is showing. */
export interface MachineWorkspacesState {
  workspaces: Record<string, WorkspaceState>;
  /** Sidebar order — insertion order, stable across selection. */
  order: string[];
  activeWorkspaceId: string;
}

// ---------------------------------------------------------------------------
// Grid level — one workspace's panes
// ---------------------------------------------------------------------------

export function newWorkspace(params: {
  id: string;
  name: string;
  scope: MachineNodeScope;
  firstPaneId: string;
  /** A workspace born from an existing session opens with that session in its
   * first pane; one born empty opens with the agent picker. */
  firstPaneScope?: OpenTerminalScope | null;
}): WorkspaceState {
  const { id, name, scope, firstPaneId, firstPaneScope = null } = params;
  return {
    id,
    name,
    scope,
    columns: [{ id: firstPaneId, panes: [{ id: firstPaneId, scope: firstPaneScope }] }],
    activePaneId: firstPaneId,
    pendingPickerPaneId: null,
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

/** Rewrites one pane in place. A `paneId` that doesn't resolve is a no-op —
 * the caller gets the same object back, so identity checks still hold. */
function mapPane(
  state: WorkspaceState,
  paneId: string,
  update: (pane: TerminalPaneState) => TerminalPaneState
): WorkspaceState {
  if (!findPaneLocation(state, paneId)) return state;
  return {
    ...state,
    columns: state.columns.map((column) => ({
      ...column,
      panes: column.panes.map((pane) => (pane.id === paneId ? update(pane) : pane)),
    })),
  };
}

/**
 * Binds a session to a SPECIFIC pane — the landing half of split-and-pick. The
 * picker spawns an agent and drops it straight into the pane it was picked in,
 * which by the time the spawn resolves may no longer be the active one (the
 * user can click another pane while a cold Sprite boots), so the target is
 * explicit rather than "wherever focus happens to be".
 *
 * The pane becomes active, and its picker stops pending — it holds a terminal
 * now, so there is nothing left to pick.
 */
export function assignPane(
  state: WorkspaceState,
  paneId: string,
  scope: OpenTerminalScope,
  pendingPrompt?: string
): WorkspaceState {
  const next = mapPane(state, paneId, (pane) => ({ ...pane, scope, pendingPrompt }));
  if (next === state) return state;

  return {
    ...next,
    activePaneId: paneId,
    pendingPickerPaneId: state.pendingPickerPaneId === paneId ? null : state.pendingPickerPaneId,
  };
}

/** Drops the starting prompt once it has been typed into the PTY, so a pane
 * that re-mounts later reattaches to a running agent instead of typing the
 * prompt at it a second time. */
export function clearPanePrompt(state: WorkspaceState, paneId: string): WorkspaceState {
  return mapPane(state, paneId, (pane) =>
    pane.pendingPrompt === undefined ? pane : { ...pane, pendingPrompt: undefined }
  );
}

/** The picker no longer wants focus. The pane stays empty and still offers its
 * picker — this only clears the auto-focus intent left by the split that made
 * it, so focus isn't yanked back on every unrelated re-render. */
export function dismissPicker(state: WorkspaceState, paneId: string): WorkspaceState {
  if (state.pendingPickerPaneId !== paneId) return state;
  return { ...state, pendingPickerPaneId: null };
}

/** Splits `fromPaneId` rightward — a new column, with one new pane, inserted
 * immediately after `fromPaneId`'s column. A `fromPaneId` that no longer
 * resolves (e.g. a stale click racing a close) is a no-op, same as every
 * other transition here. */
export function splitRight(
  state: WorkspaceState,
  fromPaneId: string,
  newColumnId: string,
  newPaneId: string
): WorkspaceState {
  const location = findPaneLocation(state, fromPaneId);
  if (!location) return state;

  const columns = [...state.columns];
  columns.splice(location.columnIndex + 1, 0, { id: newColumnId, panes: [{ id: newPaneId, scope: null }] });

  // The new pane is empty, so it shows the agent picker; pointing
  // pendingPickerPaneId at it opens that picker focused, rather than leaving
  // the user looking at a blank pane and hunting for the next click.
  return { ...state, columns, activePaneId: newPaneId, pendingPickerPaneId: newPaneId };
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

  return { ...state, columns, activePaneId: newPaneId, pendingPickerPaneId: newPaneId };
}

/**
 * A workspace never has zero panes, so closing the LAST one empties it instead
 * of removing it: the pane drops its terminal and goes back to offering the
 * picker. Refusing outright (the old behaviour) was a dead end — a lone pane
 * showing a session that no longer exists server-side could never be detached,
 * and the workspace was stuck on a terminal that would never connect again.
 *
 * Closing the last pane in a column removes the column too; closing the active
 * pane re-targets active to the first remaining pane.
 */
export function closePane(state: WorkspaceState, id: string): WorkspaceState {
  const location = findPaneLocation(state, id);
  if (!location) return state;

  const totalPanes = state.columns.reduce((sum, column) => sum + column.panes.length, 0);
  if (totalPanes <= 1) {
    return mapPane(state, id, (pane) =>
      pane.scope === null && pane.pendingPrompt === undefined
        ? pane
        : { ...pane, scope: null, pendingPrompt: undefined }
    );
  }

  const columns = state.columns
    .map((column, columnIndex) =>
      columnIndex === location.columnIndex
        ? { ...column, panes: column.panes.filter((pane) => pane.id !== id) }
        : column
    )
    .filter((column) => column.panes.length > 0);

  const activePaneId = state.activePaneId === id ? columns[0].panes[0].id : state.activePaneId;
  const pendingPickerPaneId = state.pendingPickerPaneId === id ? null : state.pendingPickerPaneId;

  return { ...state, columns, activePaneId, pendingPickerPaneId };
}

export function selectPane(state: WorkspaceState, id: string): WorkspaceState {
  if (!findPaneLocation(state, id)) return state;
  return { ...state, activePaneId: id };
}

/** Every pane of a workspace, flattened — the panes are what the sidebar must
 * NOT list separately (a split pane belongs to its workspace, not to the tree). */
export function panesOf(state: WorkspaceState): TerminalPaneState[] {
  return state.columns.flatMap((column) => column.panes);
}

// ---------------------------------------------------------------------------
// Machine level — which workspaces exist, and which one the view shows
// ---------------------------------------------------------------------------

export function initialMachineWorkspaces(workspace: WorkspaceState): MachineWorkspacesState {
  return {
    workspaces: { [workspace.id]: workspace },
    order: [workspace.id],
    activeWorkspaceId: workspace.id,
  };
}

/** Adds a workspace and shows it — a workspace is created because the user
 * asked for it, so it is what they want to be looking at. */
export function addWorkspace(state: MachineWorkspacesState, workspace: WorkspaceState): MachineWorkspacesState {
  if (state.workspaces[workspace.id]) return setActiveWorkspace(state, workspace.id);
  return {
    workspaces: { ...state.workspaces, [workspace.id]: workspace },
    order: [...state.order, workspace.id],
    activeWorkspaceId: workspace.id,
  };
}

/**
 * THE FIX: selecting a workspace switches the ENTIRE middle view to that
 * workspace's grid — every pane, in the layout it was left in — not just the
 * contents of one pane. An unknown id is a no-op rather than a blank view.
 */
export function setActiveWorkspace(state: MachineWorkspacesState, workspaceId: string): MachineWorkspacesState {
  if (!state.workspaces[workspaceId] || state.activeWorkspaceId === workspaceId) return state;
  return { ...state, activeWorkspaceId: workspaceId };
}

/** Applies a grid transition to ONE workspace, addressed by id.
 *
 * Callers name the workspace EXPLICITLY rather than letting this resolve
 * "the active one" at write time: a write can land after the user has switched
 * workspaces (a spawn resolving from a cold Sprite boot, a `ready` event), and
 * pane ids only mean anything within their own grid. Resolving late would apply
 * the write to whichever grid happened to be on screen by then — usually one
 * with no such pane, silently dropping it. */
export function updateWorkspace(
  state: MachineWorkspacesState,
  workspaceId: string,
  transition: (workspace: WorkspaceState) => WorkspaceState
): MachineWorkspacesState {
  const workspace = state.workspaces[workspaceId];
  if (!workspace) return state;

  const next = transition(workspace);
  if (next === workspace) return state;

  return { ...state, workspaces: { ...state.workspaces, [workspaceId]: next } };
}

export function workspacesOf(state: MachineWorkspacesState): WorkspaceState[] {
  return state.order.map((id) => state.workspaces[id]).filter(Boolean);
}

/** Is this session already on screen in `workspace`? */
function paneShowing(workspace: WorkspaceState, scope: OpenTerminalScope): TerminalPaneState | undefined {
  return panesOf(workspace).find(
    (pane) =>
      pane.scope?.name === scope.name &&
      (pane.scope?.projectName ?? '') === (scope.projectName ?? '') &&
      (pane.scope?.branchName ?? '') === (scope.branchName ?? '')
  );
}

/**
 * Puts `scope`'s session in front of the user inside its own workspace.
 *
 * Re-selecting the workspace is NOT enough on its own. The workspace is the
 * unit, and its panes move: the user can split, spawn other agents, and close
 * the very pane the session was opened in. Then clicking that session's sidebar
 * row again would just show a grid that no longer contains it — the session
 * would be unreachable from the sidebar for good, while its PTY kept running
 * (and billing) on the server.
 *
 * So: focus the pane already showing it, or put it in an empty pane, or split a
 * new pane for it.
 */
export function showSessionIn(
  workspace: WorkspaceState,
  scope: OpenTerminalScope,
  newPaneId: string
): WorkspaceState {
  const showing = paneShowing(workspace, scope);
  if (showing) return selectPane(workspace, showing.id);

  const panes = panesOf(workspace);
  const empty = panes.find((pane) => pane.scope === null);
  if (empty) return assignPane(workspace, empty.id, scope);

  // Anchor the split on a pane that certainly exists. `activePaneId` is the
  // right one to grow from, but every transition here no-ops on a pane id it
  // cannot resolve — so anchoring on a stale one would quietly do nothing and
  // the session would never appear, which is the exact failure this function
  // exists to prevent.
  const anchor = panes.some((pane) => pane.id === workspace.activePaneId) ? workspace.activePaneId : panes[0].id;
  return assignPane(splitDown(workspace, anchor, newPaneId), newPaneId, scope);
}

/**
 * Removes a workspace and shows a neighbour. A machine always keeps at least
 * one workspace, so removing the last one is a no-op — there would be nothing
 * left to render. (A workspace whose only pane holds a dead terminal is not a
 * dead end even then: closing that pane empties it back to the picker.)
 */
export function removeWorkspace(state: MachineWorkspacesState, workspaceId: string): MachineWorkspacesState {
  if (!state.workspaces[workspaceId] || state.order.length <= 1) return state;

  const order = state.order.filter((id) => id !== workspaceId);
  const workspaces = { ...state.workspaces };
  delete workspaces[workspaceId];

  // Falling back to the neighbour it sat next to, rather than to the first
  // workspace — closing one item should not jump the view across the sidebar.
  const removedIndex = state.order.indexOf(workspaceId);
  const neighbour = order[Math.min(removedIndex, order.length - 1)];
  const activeWorkspaceId = state.activeWorkspaceId === workspaceId ? neighbour : state.activeWorkspaceId;

  return { workspaces, order, activeWorkspaceId };
}

// ---------------------------------------------------------------------------
// Rehydration — what comes back out of localStorage is untrusted
// ---------------------------------------------------------------------------

function isPane(value: unknown): value is TerminalPaneState {
  if (typeof value !== 'object' || value === null) return false;
  const pane = value as Partial<TerminalPaneState>;
  return typeof pane.id === 'string' && (pane.scope === null || typeof pane.scope === 'object');
}

function isWorkspace(value: unknown): value is WorkspaceState {
  if (typeof value !== 'object' || value === null) return false;
  const workspace = value as Partial<WorkspaceState>;
  return (
    typeof workspace.id === 'string' &&
    typeof workspace.name === 'string' &&
    typeof workspace.scope === 'object' &&
    workspace.scope !== null &&
    Array.isArray(workspace.columns) &&
    workspace.columns.length > 0 &&
    workspace.columns.every(
      (column) =>
        typeof column?.id === 'string' &&
        Array.isArray(column.panes) &&
        column.panes.length > 0 &&
        column.panes.every(isPane)
    ) &&
    typeof workspace.activePaneId === 'string'
  );
}

/**
 * Scrubs a rehydrated `machines` blob down to what this code can actually
 * render, dropping anything it can't.
 *
 * Persisted state is written by whatever version of this app the user last ran.
 * A shape that no longer matches (a renamed field, a restructured column) would
 * otherwise flow straight into render — `columns.flatMap` on an undefined
 * `columns` throws, and a throw here takes the whole Machine page down for a
 * returning user, permanently, with no in-app way to clear the storage. Dropping
 * a stale workspace costs the user a pane layout; keeping it costs them the page.
 *
 * Transient UI intent is stripped on the way in as well: `pendingPickerPaneId`
 * (a picker that auto-focused days ago must not steal the caret on load) and
 * `pendingPrompt` (see `assignPane` — a prompt that was never delivered must
 * never be typed at an agent that has been running ever since).
 */
export function sanitizeMachines(value: unknown): Record<string, MachineWorkspacesState> {
  if (typeof value !== 'object' || value === null) return {};

  const machines: Record<string, MachineWorkspacesState> = {};

  for (const [machineId, machine] of Object.entries(value as Record<string, unknown>)) {
    if (typeof machine !== 'object' || machine === null) continue;
    const candidate = machine as Partial<MachineWorkspacesState>;
    if (typeof candidate.workspaces !== 'object' || candidate.workspaces === null) continue;

    const workspaces: Record<string, WorkspaceState> = {};
    for (const [workspaceId, workspace] of Object.entries(candidate.workspaces)) {
      if (!isWorkspace(workspace)) continue;

      const columns = workspace.columns.map((column) => ({
        ...column,
        panes: column.panes.map((pane) => ({ id: pane.id, scope: pane.scope })),
      }));
      const paneIds = columns.flatMap((column) => column.panes.map((pane) => pane.id));

      workspaces[workspaceId] = {
        ...workspace,
        columns,
        // An activePaneId naming no pane is not merely cosmetic: every grid
        // transition no-ops on a pane it cannot resolve, so a split anchored on
        // it would silently do nothing.
        activePaneId: paneIds.includes(workspace.activePaneId) ? workspace.activePaneId : paneIds[0],
        pendingPickerPaneId: null,
      };
    }

    const order = (Array.isArray(candidate.order) ? candidate.order : []).filter((id) => workspaces[id]);
    if (order.length === 0) continue;

    const activeWorkspaceId =
      typeof candidate.activeWorkspaceId === 'string' && workspaces[candidate.activeWorkspaceId]
        ? candidate.activeWorkspaceId
        : order[0];

    machines[machineId] = { workspaces, order, activeWorkspaceId };
  }

  return machines;
}

/**
 * The id of the workspace owned by one session — derived from the session
 * rather than random, so clicking that sidebar row again lands on the SAME
 * workspace, with whatever panes were split into it still there. NUL-joined:
 * project and branch names can contain '/' and ':'.
 */
export function sessionWorkspaceId(scope: OpenTerminalScope): string {
  return `session\u0000${scope.projectName ?? ''}\u0000${scope.branchName ?? ''}\u0000${scope.name}`;
}

/** Auto-name for a workspace the user created empty ("Workspace 1", "Workspace
 * 2", …) — first free index, so closing #2 and adding again reuses the gap
 * instead of drifting upward forever. */
export function nextWorkspaceName(state: MachineWorkspacesState): string {
  const taken = new Set(workspacesOf(state).map((workspace) => workspace.name));
  for (let index = 1; ; index++) {
    const name = `Workspace ${index}`;
    if (!taken.has(name)) return name;
  }
}

const AUTO_NAME_SUFFIX_LENGTH = 6;

/**
 * The auto-name for a split-and-pick spawn. Picking an agent is ONE act — no
 * name step — but `agent_terminals` rows are still keyed by name within a
 * scope, so one is minted here: the agent type (what the user actually chose,
 * so the name still means something) plus a short unique suffix, since a
 * workspace routinely runs several agents of the same type.
 *
 * `suffix` is passed in rather than generated, keeping this pure. The output
 * always satisfies `isValidAgentTerminalName` (`/^[A-Za-z0-9][A-Za-z0-9_-]*$/`)
 * for every agent type in AGENT_LAUNCH_SPECS.
 */
export function autoSessionName(agentType: string, suffix: string): string {
  const cleanSuffix = suffix.replace(/[^A-Za-z0-9]/g, '').slice(0, AUTO_NAME_SUFFIX_LENGTH);
  return cleanSuffix ? `${agentType}-${cleanSuffix}` : agentType;
}
