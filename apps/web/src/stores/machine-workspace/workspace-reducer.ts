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

/** Removing the very last remaining pane is a no-op — a workspace never has
 * zero panes. Closing the last pane in a column removes the column too;
 * closing the active pane re-targets active to the first remaining pane. */
export function closePane(state: WorkspaceState, id: string): WorkspaceState {
  const location = findPaneLocation(state, id);
  if (!location) return state;

  const totalPanes = state.columns.reduce((sum, column) => sum + column.panes.length, 0);
  if (totalPanes <= 1) return state;

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
