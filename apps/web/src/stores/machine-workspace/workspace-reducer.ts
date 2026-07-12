/**
 * Machine Workspace — functional core.
 *
 * Pure, framework-free state transitions for the pane layout shared between
 * the Machine page's Terminal-tab tree sidebar and TerminalPanes (its pane
 * region). IDs are passed in rather than generated here, so every
 * transition is deterministic and independently testable.
 *
 * Layout is a two-level structure — a horizontal row of columns, each an
 * independent vertical stack of panes — deliberately not a full recursive
 * split tree. splitRight adds a column; splitDown stacks within one.
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
 * A node in the Machine → Project → Branch tree, as the pane layer sees it:
 * an {@link OpenTerminalScope} minus the session name. Every node owns its own
 * pane grid (node-as-workspace) — a branch node's grid holds the agents working
 * in that branch's checkout. Structurally identical to `MachineTreeNode` but
 * deliberately independent of it: the store must not depend on a component.
 */
export interface MachineNodeScope {
  projectName?: string;
  branchName?: string;
}

/** The Machine node itself (neither project nor branch). A shared constant so
 * selectors can hand out a stable default without a new object per render. */
export const MACHINE_NODE_SCOPE: MachineNodeScope = Object.freeze({});

/** The node a session lives under — a session's scope IS its node plus a name. */
export function nodeOfTerminalScope(scope: OpenTerminalScope): MachineNodeScope {
  return { projectName: scope.projectName, branchName: scope.branchName };
}

/** The store key for one node's grid. NUL-joined for the same reason the tree's
 * node keys are: project and branch names can contain '/' and ':'. */
export function workspaceKey(machineId: string, node: MachineNodeScope): string {
  return `${machineId}\u0000${node.projectName ?? ''}\u0000${node.branchName ?? ''}`;
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

export interface WorkspaceState {
  columns: TerminalColumnState[];
  activePaneId: string;
  /** The empty pane whose inline agent picker should take focus — set when a
   * split makes a new pane, so the user lands in the picker instead of staring
   * at a blank pane. Cleared once that pane is filled or the picker is left. */
  pendingPickerPaneId: string | null;
}

export function initialWorkspace(firstId: string): WorkspaceState {
  return {
    columns: [{ id: firstId, panes: [{ id: firstId, scope: null }] }],
    activePaneId: firstId,
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

/** Opens a terminal into the ACTIVE pane — an explicit target rather than
 * guessing from array position, which would silently overwrite the wrong
 * pane whenever a second pane existed. */
export function openTerminal(state: WorkspaceState, scope: OpenTerminalScope): WorkspaceState {
  return assignPane(state, state.activePaneId, scope);
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
  return { columns, activePaneId: newPaneId, pendingPickerPaneId: newPaneId };
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

  return { columns, activePaneId: newPaneId, pendingPickerPaneId: newPaneId };
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

  return { columns, activePaneId, pendingPickerPaneId };
}

export function selectPane(state: WorkspaceState, id: string): WorkspaceState {
  if (!findPaneLocation(state, id)) return state;
  return { ...state, activePaneId: id };
}

const AUTO_NAME_SUFFIX_LENGTH = 6;

/**
 * The auto-name for a split-and-pick spawn. Picking an agent is ONE act — no
 * name step — but `agent_terminals` rows are still keyed by name within a
 * scope, so one is minted here: the agent type (what the user actually chose,
 * so the name still means something in a session list) plus a short unique
 * suffix, since a node routinely runs several agents of the same type.
 *
 * `suffix` is passed in rather than generated, keeping this pure. The output
 * always satisfies `isValidAgentTerminalName` (`/^[A-Za-z0-9][A-Za-z0-9_-]*$/`)
 * for every agent type in AGENT_LAUNCH_SPECS.
 */
export function autoSessionName(agentType: string, suffix: string): string {
  const cleanSuffix = suffix.replace(/[^A-Za-z0-9]/g, '').slice(0, AUTO_NAME_SUFFIX_LENGTH);
  return cleanSuffix ? `${agentType}-${cleanSuffix}` : agentType;
}
