/**
 * The pane grid's pure layout model — ported from the machine workspace
 * reducer (`stores/machine-workspace/workspace-reducer.ts`, deleted in the
 * phase-8 teardown) with its transitions unchanged and its topology removed.
 *
 * **The layout is deliberately NOT a recursive split tree.** It is a horizontal
 * row of columns, each an independent vertical stack of panes: `splitRight`
 * adds a column, `splitDown` stacks within one. Two levels, no nesting. A
 * general tree buys arbitrary layouts nobody asks a terminal grid for, and
 * costs a rebalancing problem on every close.
 *
 * **What changed in the port, and why.** The old model hung a grid off a
 * Machine and let one machine own several named workspaces, each pinned to a
 * project/branch checkout (`MachineNodeScope`, `OpenTerminalScope`,
 * `projectName`/`branchName`). Git is no longer the information architecture
 * and a sandbox belongs to the SESSION every pane here shares, so:
 *
 *  - the workspace unit is the SESSION — one grid per session, keyed by its
 *    id, matching the schema (`agent_sessions.id` owns the sandbox every pane
 *    shares by construction);
 *  - every scope tuple is gone. A pane stores a {@link PaneScope} — what it
 *    shows and the id it shows it for — and nothing about where a checkout is;
 *  - server-synced layouts (`useMachineWorkspaceSync`, the `Server*DTO` types,
 *    `mergeServerWorkspaces`) are NOT ported. Layout is local and persisted.
 *
 * Every transition no-ops on an id it cannot resolve, so a stale click racing a
 * close is never an error.
 *
 * **Pane tabs were tried and removed.** A pane briefly held several open
 * conversation tabs (`tabs: PaneScope[]`) with a strip to switch between them.
 * The UX wasn't understood well enough against the app's other tab systems
 * (browser-style tabs, the page AI chat view), so it's gone: a pane holds
 * exactly one {@link PaneScope}, period. `packages/lib/src/agent-sessions/contract.ts`'s
 * `persistedPaneStateSchema` still tolerates an incoming `tabs` array from an
 * old saved grid — it's just discarded on parse, never produced again.
 */

import type { PaneScope } from '@pagespace/lib/agent-sessions/contract';

export interface PaneState {
  id: string;
  /** `null` = unbound: the pane renders the picker. */
  scope: PaneScope | null;
}

export interface ColumnState {
  id: string;
  panes: PaneState[];
}

/** One session's pane grid. */
export interface WorkspaceState {
  /** The SESSION id whose grid this is (`agent_sessions.id`). */
  id: string;
  columns: ColumnState[];
  activePaneId: string;
  /**
   * The unbound pane whose picker should take focus — set when a split makes a
   * new pane, so the user lands in the picker instead of staring at a blank
   * rectangle hunting for the next click. Cleared once bound or dismissed.
   */
  pendingPickerPaneId: string | null;
}

interface PaneLocation {
  columnIndex: number;
  paneIndex: number;
}

function findPaneLocation(state: WorkspaceState, paneId: string): PaneLocation | null {
  for (let columnIndex = 0; columnIndex < state.columns.length; columnIndex += 1) {
    const paneIndex = state.columns[columnIndex].panes.findIndex((pane) => pane.id === paneId);
    if (paneIndex !== -1) return { columnIndex, paneIndex };
  }
  return null;
}

/**
 * A session's opening grid: one pane, already bound to the session's FIRST
 * conversation (a session is born with one — spawning a session spawns an
 * agent). The grid is never empty and never starts on a picker.
 */
export function newWorkspace(params: {
  sessionId: string;
  paneId: string;
  columnId: string;
  scope: PaneScope;
}): WorkspaceState {
  return {
    id: params.sessionId,
    columns: [
      {
        id: params.columnId,
        panes: [{ id: params.paneId, scope: params.scope }],
      },
    ],
    activePaneId: params.paneId,
    pendingPickerPaneId: null,
  };
}

function withPaneScope(state: WorkspaceState, paneId: string, scope: PaneScope): WorkspaceState {
  return {
    ...state,
    columns: state.columns.map((column) => ({
      ...column,
      panes: column.panes.map((pane) => (pane.id === paneId ? { ...pane, scope } : pane)),
    })),
    activePaneId: paneId,
    pendingPickerPaneId: state.pendingPickerPaneId === paneId ? null : state.pendingPickerPaneId,
  };
}

/** Bind a pane to what the picker chose (or a new mint, or a switched agent), and retire the picker for it. */
export function assignPane(state: WorkspaceState, paneId: string, scope: PaneScope): WorkspaceState {
  const location = findPaneLocation(state, paneId);
  if (!location) return state;
  return withPaneScope(state, paneId, scope);
}

export function dismissPicker(state: WorkspaceState, paneId: string): WorkspaceState {
  if (state.pendingPickerPaneId !== paneId) return state;
  return { ...state, pendingPickerPaneId: null };
}

/**
 * Split rightward — a new column holding one new pane, inserted immediately
 * after the source pane's column.
 */
export function splitRight(
  state: WorkspaceState,
  fromPaneId: string,
  newColumnId: string,
  newPaneId: string,
): WorkspaceState {
  const location = findPaneLocation(state, fromPaneId);
  if (!location) return state;

  const columns = [...state.columns];
  columns.splice(location.columnIndex + 1, 0, { id: newColumnId, panes: [{ id: newPaneId, scope: null }] });

  return { ...state, columns, activePaneId: newPaneId, pendingPickerPaneId: newPaneId };
}

/** Split downward — a new pane appended to the source pane's existing column. */
export function splitDown(state: WorkspaceState, fromPaneId: string, newPaneId: string): WorkspaceState {
  const location = findPaneLocation(state, fromPaneId);
  if (!location) return state;

  const columns = state.columns.map((column, columnIndex) =>
    columnIndex === location.columnIndex
      ? { ...column, panes: [...column.panes, { id: newPaneId, scope: null }] }
      : column,
  );

  return { ...state, columns, activePaneId: newPaneId, pendingPickerPaneId: newPaneId };
}

/**
 * Remove a pane. Emptying a column removes the column; closing the active pane
 * re-targets active to the first remaining pane.
 *
 * The LAST pane is deliberately not this function's business: a grid never has
 * zero panes, and closing the only one means the conversation goes back to its
 * single default pane — a decision the caller owns. This no-ops as a backstop
 * rather than filtering down to a `columns[0]` that is not there.
 */
export function closePane(state: WorkspaceState, id: string): WorkspaceState {
  const location = findPaneLocation(state, id);
  if (!location) return state;

  const totalPanes = state.columns.reduce((sum, column) => sum + column.panes.length, 0);
  if (totalPanes <= 1) return state;

  const columns = state.columns
    .map((column, columnIndex) =>
      columnIndex === location.columnIndex
        ? { ...column, panes: column.panes.filter((pane) => pane.id !== id) }
        : column,
    )
    .filter((column) => column.panes.length > 0);

  const activePaneId = state.activePaneId === id ? columns[0].panes[0].id : state.activePaneId;
  const pendingPickerPaneId = state.pendingPickerPaneId === id ? null : state.pendingPickerPaneId;

  return { ...state, columns, activePaneId, pendingPickerPaneId };
}

export function selectPane(state: WorkspaceState, id: string): WorkspaceState {
  if (state.activePaneId === id) return state;
  if (!findPaneLocation(state, id)) return state;
  return { ...state, activePaneId: id };
}

/**
 * Whether closing this pane would empty the grid. The container needs this
 * BEFORE it decides anything — show a confirm dialog, gate the close on a
 * server round-trip — and `closePane` itself only answers it by no-oping
 * (it cannot delete its own container), which is too late for a caller that
 * has to decide what to do *before* committing to the close.
 */
export function isLastPane(state: WorkspaceState, id: string): boolean {
  if (!findPaneLocation(state, id)) return false;
  return panesOf(state).length <= 1;
}

/**
 * Unbind a pane back to the picker — the first-class shape for "this mint
 * failed, start over here" (or "the conversation this pane showed just got
 * closed/deleted with nothing to rebind to"). Distinct from ever writing a
 * scope whose fields lie about what it is: an earlier version overloaded
 * `name === ''` on a still-bound chat scope as an unbound sentinel, on a field
 * the contract documents as "never an address" (any future empty-named chat
 * scope would have silently become a picker). Focuses the pane's picker on the
 * next render, the same courtesy a fresh split gets.
 */
export function resetPane(state: WorkspaceState, id: string): WorkspaceState {
  if (!findPaneLocation(state, id)) return state;
  return {
    ...state,
    columns: state.columns.map((column) => ({
      ...column,
      panes: column.panes.map((pane) => (pane.id === id ? { ...pane, scope: null } : pane)),
    })),
    pendingPickerPaneId: id,
  };
}

/**
 * Repoint EVERY pane showing `oldTargetId` to `newScope` instead. Used when
 * the row `oldTargetId` addressed was deleted and replaced, so every dangling
 * reference to it follows the replacement instead of pointing at a dead id.
 * Steals grid focus for whichever pane was already active (matching the usual
 * assign), and simply overwrites the scope for any other pane showing the same
 * target without touching `activePaneId`. A target shown nowhere is a no-op.
 */
export function assignPaneShowing(state: WorkspaceState, oldTargetId: string, newScope: PaneScope): WorkspaceState {
  let next = state;
  for (const pane of panesOf(state)) {
    if (pane.scope?.targetId !== oldTargetId) continue;
    next =
      next.activePaneId === pane.id
        ? withPaneScope(next, pane.id, newScope)
        : {
            ...next,
            columns: next.columns.map((column) => ({
              ...column,
              panes: column.panes.map((p) => (p.id === pane.id ? { ...p, scope: newScope } : p)),
            })),
          };
  }
  return next;
}

/** Every pane, flattened in visual order (left-to-right, top-to-bottom). */
export function panesOf(state: WorkspaceState): PaneState[] {
  return state.columns.flatMap((column) => column.panes);
}

/** The pane bound to a given target, if any — used to focus rather than duplicate. */
export function paneShowing(state: WorkspaceState, targetId: string): PaneState | undefined {
  return panesOf(state).find((pane) => pane.scope?.targetId === targetId);
}
