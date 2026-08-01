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
 */

import type { PaneScope } from '@pagespace/lib/agent-sessions/contract';

export interface PaneState {
  id: string;
  /** `null` = unbound: the pane renders the picker. */
  scope: PaneScope | null;
  /**
   * This pane's open conversation tabs, INCLUDING the active one when
   * `scope.kind === 'chat'` — `scope` is which tab is active, `tabs` is the
   * full ordered set. Always `[]` for a terminal/page pane or an unbound
   * picker: only chat panes tab.
   */
  tabs: PaneScope[];
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
        panes: [{ id: params.paneId, scope: params.scope, tabs: params.scope.kind === 'chat' ? [params.scope] : [] }],
      },
    ],
    activePaneId: params.paneId,
    pendingPickerPaneId: null,
  };
}

/**
 * The shared tab-list transition behind `assignPane`'s implicit bookkeeping,
 * `replaceTab`, and `openTab` — all three are really "replace whichever tab
 * matches `oldTargetId` (or, if none does, dedupe-or-append `newScope`) and
 * make it active"; they differ only in WHERE `oldTargetId` comes from:
 *
 * - `assignPane` derives it from `pane.scope` at call time — correct for a
 *   single-step, already-settled assign (e.g. an instant History-pick), but
 *   NOT across an async two-step mint (loading → resolved): the loading call
 *   already overwrote `pane.scope` by the time the resolved call runs.
 * - `replaceTab` takes it as an explicit parameter, so a caller can capture
 *   the ORIGINAL id once, before starting a mint sequence, and reuse it for
 *   both the loading and resolved calls.
 * - `openTab` is `replaceTab` with `oldTargetId: null` — nothing to replace,
 *   only dedupe-or-append.
 *
 * A still-loading `newScope` (`targetId === null`) always leaves `tabs`
 * untouched — there is nothing settled yet to record.
 */
function tabsForChatAssign(currentTabs: PaneScope[], oldTargetId: string | null, newScope: PaneScope): PaneScope[] {
  if (newScope.targetId === null) return currentTabs;
  if (oldTargetId !== null) {
    const idx = currentTabs.findIndex((tab) => tab.targetId === oldTargetId);
    if (idx !== -1) return currentTabs.map((tab, i) => (i === idx ? newScope : tab));
  }
  const dupIdx = currentTabs.findIndex((tab) => tab.targetId === newScope.targetId);
  if (dupIdx !== -1) return currentTabs.map((tab, i) => (i === dupIdx ? newScope : tab));
  return [...currentTabs, newScope];
}

function withPaneScopeAndTabs(
  state: WorkspaceState,
  paneId: string,
  scope: PaneScope,
  tabs: PaneScope[],
): WorkspaceState {
  return {
    ...state,
    columns: state.columns.map((column) => ({
      ...column,
      panes: column.panes.map((pane) => (pane.id === paneId ? { ...pane, scope, tabs } : pane)),
    })),
    activePaneId: paneId,
    pendingPickerPaneId: state.pendingPickerPaneId === paneId ? null : state.pendingPickerPaneId,
  };
}

/** Bind a pane to what the picker chose, and retire the picker for it. */
export function assignPane(state: WorkspaceState, paneId: string, scope: PaneScope): WorkspaceState {
  const location = findPaneLocation(state, paneId);
  if (!location) return state;
  const pane = state.columns[location.columnIndex].panes[location.paneIndex];
  if (scope.kind !== 'chat') return withPaneScopeAndTabs(state, paneId, scope, []);
  const oldTargetId = pane.scope?.kind === 'chat' ? pane.scope.targetId : null;
  return withPaneScopeAndTabs(state, paneId, scope, tabsForChatAssign(pane.tabs, oldTargetId, scope));
}

/**
 * Replace the tab addressed by `oldTargetId` with `newScope` and activate it
 * — the explicit-identity sibling of `assignPane`'s own bookkeeping, for a
 * caller that cannot rely on `pane.scope` still naming the original tab (see
 * `tabsForChatAssign`'s docblock). `oldTargetId: null` degrades to
 * dedupe-or-append, which is exactly `openTab`'s behavior.
 */
export function replaceTab(
  state: WorkspaceState,
  paneId: string,
  oldTargetId: string | null,
  newScope: PaneScope,
): WorkspaceState {
  const location = findPaneLocation(state, paneId);
  if (!location) return state;
  const pane = state.columns[location.columnIndex].panes[location.paneIndex];
  return withPaneScopeAndTabs(state, paneId, newScope, tabsForChatAssign(pane.tabs, oldTargetId, newScope));
}

/** Append `newScope` as a new tab (dedupe-and-activate if already open) and activate it — the "+" primitive. */
export function openTab(state: WorkspaceState, paneId: string, newScope: PaneScope): WorkspaceState {
  return replaceTab(state, paneId, null, newScope);
}

/** Activate an already-open tab — purely local, the tab list itself is untouched. No-ops if `targetId` isn't one of this pane's tabs. */
export function switchTab(state: WorkspaceState, paneId: string, targetId: string): WorkspaceState {
  const location = findPaneLocation(state, paneId);
  if (!location) return state;
  const pane = state.columns[location.columnIndex].panes[location.paneIndex];
  const match = pane.tabs.find((tab) => tab.targetId === targetId);
  if (!match) return state;
  return {
    ...state,
    columns: state.columns.map((column) => ({
      ...column,
      panes: column.panes.map((p) => (p.id === paneId ? { ...p, scope: match } : p)),
    })),
    activePaneId: paneId,
  };
}

/**
 * Remove the tab addressed by `targetId`. If it was the active one, activate
 * the tab immediately before it (or the new first, if it WAS first) — a
 * neighbor rather than losing the pane's focus. With no tabs left, the pane
 * reverts to the picker, mirroring `resetPane`.
 */
export function closeTab(state: WorkspaceState, paneId: string, targetId: string): WorkspaceState {
  const location = findPaneLocation(state, paneId);
  if (!location) return state;
  const pane = state.columns[location.columnIndex].panes[location.paneIndex];
  const idx = pane.tabs.findIndex((tab) => tab.targetId === targetId);
  if (idx === -1) return state;

  const tabs = [...pane.tabs.slice(0, idx), ...pane.tabs.slice(idx + 1)];
  const wasActive = pane.scope?.kind === 'chat' && pane.scope.targetId === targetId;
  if (!wasActive) return withPaneScopeAndTabsNoRefocus(state, paneId, pane.scope, tabs);

  if (tabs.length === 0) {
    return {
      ...withPaneScopeAndTabsNoRefocus(state, paneId, null, tabs),
      pendingPickerPaneId: paneId,
    };
  }
  const nextActive = tabs[Math.max(0, idx - 1)];
  return withPaneScopeAndTabsNoRefocus(state, paneId, nextActive, tabs);
}

/** Like the assign helper above, but never steals grid focus or dismisses another pane's picker — used by `closeTab`, which changes a pane's OWN content, not which pane is active. */
function withPaneScopeAndTabsNoRefocus(
  state: WorkspaceState,
  paneId: string,
  scope: PaneScope | null,
  tabs: PaneScope[],
): WorkspaceState {
  return {
    ...state,
    columns: state.columns.map((column) => ({
      ...column,
      panes: column.panes.map((pane) => (pane.id === paneId ? { ...pane, scope, tabs } : pane)),
    })),
  };
}

/** Every open tab across the grid, tagged with the pane that owns it. */
export function tabsOf(state: WorkspaceState): { paneId: string; tab: PaneScope }[] {
  return panesOf(state).flatMap((pane) => pane.tabs.map((tab) => ({ paneId: pane.id, tab })));
}

/** One pane's own open tabs — `[]` for an unresolvable pane. */
export function paneTabsOf(state: WorkspaceState, paneId: string): PaneScope[] {
  return panesOf(state).find((pane) => pane.id === paneId)?.tabs ?? [];
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
  columns.splice(location.columnIndex + 1, 0, { id: newColumnId, panes: [{ id: newPaneId, scope: null, tabs: [] }] });

  return { ...state, columns, activePaneId: newPaneId, pendingPickerPaneId: newPaneId };
}

/** Split downward — a new pane appended to the source pane's existing column. */
export function splitDown(state: WorkspaceState, fromPaneId: string, newPaneId: string): WorkspaceState {
  const location = findPaneLocation(state, fromPaneId);
  if (!location) return state;

  const columns = state.columns.map((column, columnIndex) =>
    columnIndex === location.columnIndex
      ? { ...column, panes: [...column.panes, { id: newPaneId, scope: null, tabs: [] }] }
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
 * failed, start over here." Distinct from ever writing a scope whose fields
 * lie about what it is: an earlier version overloaded `name === ''` on a
 * still-bound chat scope as an unbound sentinel, on a field the contract
 * documents as "never an address" (any future empty-named chat scope would
 * have silently become a picker). Focuses the pane's picker on the next
 * render, the same courtesy a fresh split gets.
 */
export function resetPane(state: WorkspaceState, id: string): WorkspaceState {
  if (!findPaneLocation(state, id)) return state;
  return {
    ...state,
    columns: state.columns.map((column) => ({
      ...column,
      panes: column.panes.map((pane) => (pane.id === id ? { ...pane, scope: null, tabs: [] } : pane)),
    })),
    pendingPickerPaneId: id,
  };
}

/**
 * Assign whichever pane is showing `oldTargetId` to a new scope — used when
 * the row it addressed was deleted and replaced, so the pane the user was
 * looking at follows the replacement instead of dangling on a dead id. A
 * target shown nowhere is a no-op: there is nothing stale to prune.
 */
export function assignPaneShowing(state: WorkspaceState, oldTargetId: string, newScope: PaneScope): WorkspaceState {
  const pane = paneShowing(state, oldTargetId);
  if (!pane) return state;
  return assignPane(state, pane.id, newScope);
}

/** Every pane, flattened in visual order (left-to-right, top-to-bottom). */
export function panesOf(state: WorkspaceState): PaneState[] {
  return state.columns.flatMap((column) => column.panes);
}

/** The pane bound to a given target, if any — used to focus rather than duplicate. */
export function paneShowing(state: WorkspaceState, targetId: string): PaneState | undefined {
  return panesOf(state).find((pane) => pane.scope?.targetId === targetId);
}
