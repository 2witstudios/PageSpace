/**
 * Agent workspace pane grid — the pure layout model and its VERB algebra
 * (epic Phase 3, the #2202 machine-panes pattern re-cut for sessions).
 *
 * This module is the ONE definition of every grid transition. The pane model
 * and its transitions were ported VERBATIM from the web client's
 * `stores/agent-workspace/pane-reducer.ts` (which now re-exports from here),
 * so the browser's optimistic local apply and the server's verb engine
 * (`apps/web/src/lib/agent-sessions/workspace-layout-runtime.ts`) run the
 * SAME reducer — the two writers the blob era kept "byte-identical" by
 * convention are structurally one writer.
 *
 * **The layout is deliberately NOT a recursive split tree.** It is a
 * horizontal row of columns, each an independent vertical stack of panes:
 * `splitRight` adds a column, `splitDown` stacks within one. Two levels, no
 * nesting. Every transition no-ops on an id it cannot resolve, so a stale
 * click racing a close is never an error.
 *
 * **Verbs.** A grid mutation crossing the wire is one of a small closed set
 * of verbs ({@link WorkspaceLayoutVerb}), each carrying every id it needs —
 * pane/column ids are CLIENT-MINTED, so optimistic application needs no
 * server round-trip for identity. `applyVerbLocal` is a STRUCTURAL check
 * (did the target resolve / did the transition run), not a byte diff — the
 * persistence layer's own content diff
 * (`services/agent-sessions/workspace-layout-store.ts`'s
 * `replaceWorkspaceGrid`) is the final authority on whether anything
 * observably changed, and therefore on rev bumps and broadcasts.
 *
 * **What rows persist vs what the state carries.** `WorkspaceState` still
 * carries `activePaneId`/`pendingPickerPaneId` (the transitions maintain
 * them and the client renders them) and each scope's `name`/`agentPageId`
 * display fields — but NONE of those persist relationally: focus is
 * client-local view state (the machines decision — it does not restore
 * cross-device) and labels derive at read time. `gridFromWorkspaceState` is
 * the ONE projection from the rich state to what rows own
 * (`{id, kind, targetId}` per pane); `workspaceStateFromGrid` is its inverse,
 * re-hydrating display fields from the rolling-deploy blob where available.
 * The drift-guard property test (blob ≡ rows after ANY verb sequence) pins
 * these two as exact structural inverses.
 *
 * **Server-side divergences from the client store (deliberate, documented):**
 *  - `open_conversation`'s replaceable-pane policy is the pure structural
 *    subset, narrowed only by what a caller can state on the wire
 *    (`preferSplit`, `excludeTargetId`). The client additionally protects
 *    dirty page panes (`useEditingStore`) and non-live conversations (issue
 *    #2295) — both are client-side predicates the server cannot evaluate,
 *    which is why the browser store never emits this verb at all: it runs
 *    the policy itself against those guards and posts the RESULT
 *    (`assign_pane`, or `split_right` + `assign_pane`). `open_conversation`
 *    is the SERVER's placement verb — the AI tool paths, where no browser is
 *    in the loop to consult.
 *  - `close_pane` on the LAST pane is a structural no-op here exactly as in
 *    the reducer: emptying a session ends it, which is a session-lifecycle
 *    act (the end route), never a layout verb.
 *
 * **Sizing (issue #2208).** Beyond structure, a container's members may carry
 * FRACTIONS — `widthFraction` per column, `heightFraction` per pane — the
 * reserved-since-Phase-3 real columns the resize verbs finally write. The
 * invariant is enforced HERE, never at a call site; see
 * {@link rebalanceFractions} for its exact statement.
 */

import { z } from 'zod';
import { paneScopeSchema, type PaneKind, type PaneScope, type PersistedColumnState, type PersistedWorkspaceState } from './contract';

// ---------------------------------------------------------------------------
// The pane model (ported from apps/web pane-reducer.ts — see module doc)
// ---------------------------------------------------------------------------

export interface PaneState {
  id: string;
  /** `null` = unbound: the pane renders the picker. */
  scope: PaneScope | null;
  /**
   * This pane's share of its COLUMN's height. ABSENT when the column is
   * unsized (every pane splits it evenly) — the absence IS the state, never
   * an explicit null, so a grid the reducer built and one rehydrated from
   * rows are byte-identical. Only ever written by the reducer; see
   * {@link rebalanceFractions} for the invariant it maintains.
   */
  heightFraction?: number;
}

export interface ColumnState {
  id: string;
  panes: PaneState[];
  /**
   * This column's share of the grid's width. Absent when the grid is unsized,
   * exactly like {@link PaneState.heightFraction}.
   */
  widthFraction?: number;
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

// ---------------------------------------------------------------------------
// Fractions — the sizing invariant, enforced in the reducer (issue #2208)
// ---------------------------------------------------------------------------

/**
 * How far a fraction sum may drift from 1 and still count as satisfying the
 * invariant. Float arithmetic makes exact equality untestable; every function
 * here settles its own residual (see {@link settleToOne}), so real drift stays
 * far below this.
 */
export const FRACTION_EPSILON = 1e-6;

/**
 * The smallest share a member may hold. A resize that would starve a sibling
 * is CLAMPED to this rather than refused — a verb is total, and "you asked for
 * something impossible" is not a failure mode a pane grid needs. The renderer
 * enforces its own, stricter drag minimum on top; this is the structural floor
 * that keeps a pane from becoming unclickable, not a UI constant.
 */
export const MIN_FRACTION = 0.05;

/**
 * The grid every stored fraction snaps to (1e-5 — a hundredth of a percent of
 * a container, orders of magnitude finer than a pixel).
 *
 * This is NOT cosmetic rounding. The columns are Postgres `real` (float4), so
 * a double written out does not read back bit-identical — and the store's
 * "did anything actually change" test is a `JSON.stringify` comparison of the
 * grid it just read against the grid it is about to write. Without a shared
 * quantization every write would look like a change: a resize would never be
 * idempotent, retries would bump the rev forever, and every unrelated verb on
 * a sized grid would re-broadcast. Snapping both the reducer's output and the
 * store's reads to the same coarse grid makes the round-trip an identity:
 * float4's relative error (~6e-8) is ~80x smaller than the distance from a
 * grid point to its rounding boundary (5e-6), so `q(float4(q(x))) === q(x)`
 * with room to spare.
 */
const FRACTION_PRECISION = 1e-5;

/** Snap a fraction to {@link FRACTION_PRECISION}. See its doc for why this exists. */
export function quantizeFraction(value: number): number {
  return Math.round(value / FRACTION_PRECISION) * FRACTION_PRECISION;
}

/**
 * A stored fraction in canonical form, or `null` when it is absent,
 * non-finite, or not positive. THE funnel through which an external number
 * (a row, a wire payload, a hand-written blob) becomes a fraction this module
 * will compare or persist.
 */
function readFraction(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? quantizeFraction(value) : null;
}

/**
 * Put a container's shares in canonical form: every member snapped to the
 * precision grid, and the residual folded into the LARGEST member so the sum
 * is 1 to within float representation error.
 *
 * The residual lands on the largest, never on the last: whichever member
 * happens to be final could be a small one, and pushing it under
 * {@link MIN_FRACTION} would break the very invariant this exists to close.
 * Recomputing the largest as `1 - everything else` (rather than adding a
 * correction to it) keeps it ON the grid, since both terms already are.
 */
function settleToOne(values: number[]): number[] {
  if (values.length === 0) return values;
  const settled = values.map(quantizeFraction);
  let largest = 0;
  for (let index = 1; index < settled.length; index += 1) {
    if (settled[index] > settled[largest]) largest = index;
  }
  const others = settled.reduce((sum, value, index) => (index === largest ? sum : sum + value), 0);
  settled[largest] = quantizeFraction(1 - others);
  return settled;
}

/**
 * Scale `values` so they sum to `total`, with no member below the floor.
 *
 * Proportional scaling alone cannot honor a floor: squeezing a large sibling
 * in can drive a small one under it. So this water-fills — pin whatever fell
 * under the floor AT the floor, redistribute the remaining budget across the
 * rest in proportion, repeat. The pinned set only ever grows (pinning shrinks
 * the budget for everyone else), so this terminates in at most one pass per
 * member; the loop bound is a statement of that, not a hope.
 *
 * `total / n` caps the floor, so a container too small to give everyone
 * `MIN_FRACTION` degrades to an even split instead of demanding more than 100%.
 */
function scaleToTotal(values: number[], total: number): number[] {
  const count = values.length;
  if (count === 0) return [];
  const floor = Math.min(MIN_FRACTION, total / count);
  const sum = values.reduce((running, value) => running + value, 0);
  let shares = sum > 0 ? values.map((value) => (value / sum) * total) : values.map(() => total / count);

  for (let pass = 0; pass < count; pass += 1) {
    const pinned = shares.map((share) => share < floor);
    const pinnedCount = pinned.filter(Boolean).length;
    if (pinnedCount === 0 || pinnedCount === count) break;
    const budget = total - floor * pinnedCount;
    const freeSum = shares.reduce((running, share, index) => (pinned[index] ? running : running + share), 0);
    shares = shares.map((share, index) =>
      pinned[index]
        ? floor
        : freeSum > 0
          ? (share / freeSum) * budget
          : budget / (count - pinnedCount),
    );
  }

  return shares.map((share) => (share < floor ? floor : share));
}

/**
 * THE FRACTION INVARIANT, and the one function that establishes it.
 *
 * For any container (the grid's columns, or one column's panes) exactly one of
 * these holds:
 *
 *  - **Unsized** — EVERY member's fraction is absent. Nobody has ever resized
 *    this container, and the renderer splits it evenly. This is the opening
 *    state and it is deliberately not `1/n` rows: writing shares nobody chose
 *    would make every split a sizing change.
 *  - **Sized** — EVERY member's fraction is a finite number `>= MIN_FRACTION`,
 *    and they sum to 1 within {@link FRACTION_EPSILON}.
 *
 * A container is never MIXED, in either direction: a resize materializes the
 * whole container (unsized siblings start from their even share), and a
 * membership change re-establishes the invariant for the new membership. Wire
 * input that arrives mixed — hand-crafted, or written by some future partial
 * writer — is read as UNSIZED wholesale rather than half-trusted, because a
 * subset of fractions summing to less than 1 has no defensible rendering.
 *
 * `before` is what each member of the NEW membership carried; `null` marks a
 * newcomer (a fresh split, or a pane moved in from another column). Newcomers
 * take an even share of the new container and the survivors keep their
 * relative proportions inside whatever is left.
 */
function rebalanceFractions(before: Array<number | null | undefined>): Array<number | null> {
  const count = before.length;
  if (count === 0) return [];
  // A LONE member is always unsized: it owns its whole container, so a stored
  // `1.0` states nothing the structure does not already say — and it would
  // make a container that had shrunk to one look "sized", so the next split
  // into it would rebalance against a share nobody chose. `resizeColumn` and
  // `resizePane` refuse a one-member container for the same reason.
  if (count === 1) return [null];
  const known = before.map(readFraction);
  if (known.every((fraction) => fraction === null)) return known;

  const newcomerShare = 1 / count;
  const newcomers = known.filter((fraction) => fraction === null).length;
  // `newcomers < count` here (an all-null container returned above), so the
  // survivors' budget is always positive.
  const survivors = scaleToTotal(
    known.filter((fraction): fraction is number => fraction !== null),
    1 - newcomerShare * newcomers,
  );
  let survivorIndex = 0;
  const merged = known.map((fraction) =>
    fraction === null ? newcomerShare : survivors[survivorIndex++],
  );
  return settleToOne(merged);
}

/**
 * The shares a container currently renders at: its stored fractions when it is
 * sized, an even split when it is not. The starting point every resize
 * materializes from.
 */
function currentShares(before: Array<number | null | undefined>): number[] {
  const known = before.map(readFraction);
  if (known.some((fraction) => fraction === null)) return known.map(() => 1 / known.length);
  return settleToOne(scaleToTotal(known as number[], 1));
}

/**
 * Give member `index` the share it asked for and let the others absorb the
 * difference in proportion. The request is CLAMPED into what the floor leaves
 * available rather than refused — see {@link MIN_FRACTION}.
 */
function resizeShare(shares: number[], index: number, requested: number): number[] {
  const count = shares.length;
  const floor = Math.min(MIN_FRACTION, 1 / count);
  const ceiling = 1 - floor * (count - 1);
  const target = Math.min(Math.max(requested, floor), ceiling);
  const others = scaleToTotal(
    shares.filter((_, other) => other !== index),
    1 - target,
  );
  let otherIndex = 0;
  return settleToOne(shares.map((_, member) => (member === index ? target : others[otherIndex++])));
}

/** Two fraction lists that render identically — the reducer's "nothing changed" test. */
function sameFractions(a: Array<number | null | undefined>, b: Array<number | null>): boolean {
  return a.every((value, index) => {
    const left = readFraction(value);
    const right = b[index];
    if (left === null || right === null) return left === right;
    return Math.abs(left - right) < FRACTION_EPSILON;
  });
}

/**
 * Re-seat a column's width, preserving object identity when the value is
 * unchanged so the callers' `next !== state` applied-check stays honest. An
 * unsized member carries NO key at all rather than an explicit null — the
 * absence IS the state, and emitting nulls would churn every existing grid.
 */
function withWidthFraction(column: ColumnState, fraction: number | null): ColumnState {
  if ((column.widthFraction ?? null) === fraction) return column;
  if (fraction === null) {
    const { widthFraction: _unsized, ...rest } = column;
    return rest;
  }
  return { ...column, widthFraction: fraction };
}

/** {@link withWidthFraction}'s pane-height twin. */
function withHeightFraction(pane: PaneState, fraction: number | null): PaneState {
  if ((pane.heightFraction ?? null) === fraction) return pane;
  if (fraction === null) {
    const { heightFraction: _unsized, ...rest } = pane;
    return rest;
  }
  return { ...pane, heightFraction: fraction };
}

/** Re-establish the width invariant across the grid's columns after any membership change. */
function normalizeColumnWidths(columns: ColumnState[]): ColumnState[] {
  const fractions = rebalanceFractions(columns.map((column) => column.widthFraction));
  return columns.map((column, index) => withWidthFraction(column, fractions[index]));
}

/** Re-establish the height invariant inside ONE column after any membership change. */
function normalizeColumnHeights(column: ColumnState): ColumnState {
  const fractions = rebalanceFractions(column.panes.map((pane) => pane.heightFraction));
  const panes = column.panes.map((pane, index) => withHeightFraction(pane, fractions[index]));
  return panes.every((pane, index) => pane === column.panes[index]) ? column : { ...column, panes };
}

/**
 * The one exit every structural transition takes: re-establish BOTH invariants
 * over whatever membership the transition produced. Cheap and idempotent — an
 * unsized grid passes through untouched (and identical by reference), which is
 * why the pre-#2208 transitions could adopt it without changing behavior.
 */
function normalizeGrid(columns: ColumnState[]): ColumnState[] {
  return normalizeColumnWidths(columns.map(normalizeColumnHeights));
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

  // The new column is a NEWCOMER: on a grid nobody has sized this is a no-op,
  // and on a sized one it takes an even share while its siblings keep their
  // proportions inside the rest (the invariant's insert rule).
  return { ...state, columns: normalizeGrid(columns), activePaneId: newPaneId, pendingPickerPaneId: newPaneId };
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

  return { ...state, columns: normalizeGrid(columns), activePaneId: newPaneId, pendingPickerPaneId: newPaneId };
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

  // Removal's side of the invariant: the survivors of both containers (the
  // pane's column, and the grid if that column emptied out) rescale to fill
  // what the departure freed, keeping their relative proportions.
  return { ...state, columns: normalizeGrid(columns), activePaneId, pendingPickerPaneId };
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

/**
 * Give a column `widthFraction` of the grid's width, and let its siblings
 * absorb the difference in proportion.
 *
 * TOTAL, like every transition here:
 *  - a column id that does not resolve is a no-op;
 *  - a grid with ONE column is a no-op — a lone column always owns the whole
 *    width, so there is no share to state and nothing to renormalize against;
 *  - a request outside what {@link MIN_FRACTION} leaves available is CLAMPED,
 *    not refused (a 200% column is a caller bug, not a reason to fail a grid);
 *  - a request that resolves to what the column already renders at returns the
 *    grid unchanged, so a re-sent resize does not bump the rev.
 *
 * A grid nobody has sized MATERIALIZES here: every column's even share becomes
 * a stored fraction, because the moment one column is explicitly sized the
 * others' shares stop being derivable from the count alone.
 */
export function resizeColumn(state: WorkspaceState, columnId: string, widthFraction: number): WorkspaceState {
  const index = state.columns.findIndex((column) => column.id === columnId);
  if (index === -1) return state;
  if (state.columns.length < 2) return state;

  const next = resizeShare(currentShares(state.columns.map((column) => column.widthFraction)), index, widthFraction);
  if (sameFractions(state.columns.map((column) => column.widthFraction), next)) return state;
  return { ...state, columns: state.columns.map((column, at) => withWidthFraction(column, next[at])) };
}

/**
 * Give a pane `heightFraction` of ITS COLUMN's height, and let the panes
 * stacked with it absorb the difference in proportion. Heights are always
 * column-local: a pane's share says nothing about panes in other columns.
 *
 * Same totality rules as {@link resizeColumn} — an unresolvable pane, or a
 * pane alone in its column, is a no-op; the request is clamped; an unchanged
 * result returns the grid unchanged.
 */
export function resizePane(state: WorkspaceState, paneId: string, heightFraction: number): WorkspaceState {
  const location = findPaneLocation(state, paneId);
  if (!location) return state;
  const column = state.columns[location.columnIndex];
  if (column.panes.length < 2) return state;

  const next = resizeShare(
    currentShares(column.panes.map((pane) => pane.heightFraction)),
    location.paneIndex,
    heightFraction,
  );
  if (sameFractions(column.panes.map((pane) => pane.heightFraction), next)) return state;
  const panes = column.panes.map((pane, at) => withHeightFraction(pane, next[at]));
  return {
    ...state,
    columns: state.columns.map((existing, at) => (at === location.columnIndex ? { ...existing, panes } : existing)),
  };
}

/**
 * Relocate a pane to another column, another position, or both. The pane's
 * BINDING is untouched — this moves a rectangle, never what it shows.
 *
 * `toIndex` is the destination's 0-based slot AFTER the pane has left its old
 * one; omitted means "append". It is CLAMPED into range rather than refused,
 * so `toIndex: 99` means "last" and a negative one means "first". Positions
 * renumber contiguously by construction: order IS array order here, and the
 * persistence layer derives `orderIndex` from it, so there is no gap to leave
 * behind and no renumbering pass to forget.
 *
 * TOTAL:
 *  - an unresolvable pane id or destination column id is a no-op (a stale
 *    agent view of the grid must not be an error);
 *  - a move that lands the pane exactly where it already is returns the grid
 *    unchanged;
 *  - a column emptied by the departure is REMOVED, exactly as `close_pane`
 *    removes one — a grid never carries an empty column.
 *
 * Sizing: the pane arrives in its destination as a NEWCOMER (an even share of
 * the column it joins), because a height chosen against one column's stack
 * means nothing in another. A same-column reorder is a pure permutation and
 * carries each pane's own fraction along with it.
 */
export function movePane(
  state: WorkspaceState,
  paneId: string,
  toColumnId: string,
  toIndex?: number,
): WorkspaceState {
  const location = findPaneLocation(state, paneId);
  if (!location) return state;
  const targetColumnIndex = state.columns.findIndex((column) => column.id === toColumnId);
  if (targetColumnIndex === -1) return state;

  const sourceColumn = state.columns[location.columnIndex];
  const sameColumn = targetColumnIndex === location.columnIndex;
  const pane = sourceColumn.panes[location.paneIndex];

  // The destination's length once the pane has left it (only a same-column
  // move shortens it), which is what `toIndex` is clamped against.
  const destinationLength = state.columns[targetColumnIndex].panes.length - (sameColumn ? 1 : 0);
  const desiredIndex = toIndex ?? destinationLength;
  const insertAt = Math.min(Math.max(Math.trunc(desiredIndex), 0), destinationLength);
  if (sameColumn && insertAt === location.paneIndex) return state;

  const columns = state.columns
    .map((column, index) => {
      if (index !== location.columnIndex && index !== targetColumnIndex) return column;
      let panes = column.panes;
      if (index === location.columnIndex) panes = panes.filter((existing) => existing.id !== paneId);
      if (index === targetColumnIndex) {
        const arriving = sameColumn ? pane : withHeightFraction(pane, null);
        panes = [...panes.slice(0, insertAt), arriving, ...panes.slice(insertAt)];
      }
      return { ...column, panes };
    })
    .filter((column) => column.panes.length > 0);

  return { ...state, columns: normalizeGrid(columns) };
}

/**
 * Reorder the grid's columns. Panes travel with their column, and each
 * column's stored width travels with it too — a permutation moves shares
 * around, it never changes them, so the invariant holds by construction.
 *
 * DELIBERATELY FORGIVING, and this is the interesting choice: `columnIds` is
 * read as a PREFIX, not as a required permutation. Ids that resolve are placed
 * first, in the order given; duplicates after the first mention are ignored;
 * ids that resolve to nothing are skipped; and every column the caller did not
 * mention keeps its current relative order behind them. So
 * `reorder_columns(['c3'])` means "put c3 first, leave the rest alone" — the
 * request an agent rearranging a workspace it only partly knows actually wants
 * to make. Refusing anything short of a full permutation would make the verb
 * unusable from a stale snapshot, which is the only kind an agent ever holds.
 *
 * An order identical to the current one returns the grid unchanged.
 */
export function reorderColumns(state: WorkspaceState, columnIds: readonly string[]): WorkspaceState {
  const byId = new Map(state.columns.map((column) => [column.id, column]));
  const placed = new Set<string>();
  const leading: ColumnState[] = [];
  for (const columnId of columnIds) {
    const column = byId.get(columnId);
    if (!column || placed.has(columnId)) continue;
    placed.add(columnId);
    leading.push(column);
  }
  const columns = [...leading, ...state.columns.filter((column) => !placed.has(column.id))];
  if (columns.every((column, index) => column === state.columns[index])) return state;
  return { ...state, columns };
}

/** Every pane, flattened in visual order (left-to-right, top-to-bottom). */
export function panesOf(state: WorkspaceState): PaneState[] {
  return state.columns.flatMap((column) => column.panes);
}

/** The pane bound to a given target, if any — used to focus rather than duplicate. */
export function paneShowing(state: WorkspaceState, targetId: string): PaneState | undefined {
  return panesOf(state).find((pane) => pane.scope?.targetId === targetId);
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

const id = z.string().min(1);

/**
 * The closed verb set. Every id a verb needs is client-minted and arrives in
 * the payload; `ensure` and `open_conversation` carry mint ids they only use
 * when they actually create something (idempotent retries reuse the same
 * minted ids, which is what makes a replayed create structurally harmless —
 * and the op-memory table catches the replays that would not be).
 */
export const workspaceLayoutVerbSchema = z.discriminatedUnion('type', [
  /** Give a session its opening grid, once. A grid already existing is a no-op. */
  z.object({ type: z.literal('ensure'), columnId: id, paneId: id, scope: paneScopeSchema }),
  z.object({ type: z.literal('split_right'), fromPaneId: id, newColumnId: id, newPaneId: id }),
  z.object({ type: z.literal('split_down'), fromPaneId: id, newPaneId: id }),
  z.object({ type: z.literal('assign_pane'), paneId: id, scope: paneScopeSchema }),
  z.object({ type: z.literal('close_pane'), paneId: id }),
  z.object({ type: z.literal('reset_pane'), paneId: id }),
  /**
   * Focus-or-assign: make `scope`'s target visible — focus the pane already
   * showing it, else fill the first replaceable pane, else split right from
   * the active pane using the minted `newColumnId`/`newPaneId`. On a session
   * with no grid at all, behaves as `ensure` with the minted ids.
   *
   * The two optional narrowings exist for SERVER-DRIVEN placement (the AI
   * tool paths), which is `open_conversation`'s only in-repo emitter — the
   * browser store resolves this policy itself against its client-only guards
   * and posts the resulting primitive (`assign_pane`, or `split_right` +
   * `assign_pane`) instead. Both mirror, exactly, the options the client
   * store's own `openPage` has carried since the `open_page_pane` tool
   * landed:
   *  - `preferSplit`: an agent ADDS a surface beside what the user is doing,
   *    it never navigates the user's panes — so only an unbound picker pane
   *    may be filled and anything bound gets a split instead.
   *  - `excludeTargetId`: never replace the pane showing THIS target — the
   *    invoking conversation's own pane, which must not be evicted by its
   *    own tool call.
   */
  z.object({
    type: z.literal('open_conversation'),
    scope: paneScopeSchema,
    newColumnId: id,
    newPaneId: id,
    preferSplit: z.boolean().optional(),
    excludeTargetId: z.string().min(1).optional(),
  }),
  /** Repoint every pane showing `oldTargetId` at `scope` (delete-and-remint flows). */
  z.object({ type: z.literal('replace_conversation'), oldTargetId: id, scope: paneScopeSchema }),

  // --- Rearrange (issue #2208) ------------------------------------------
  // The four verbs the entity promotion unblocked. Each is total: see the
  // transition it dispatches to for exactly what an odd-but-representable
  // payload does. `z.number()` in zod v4 already rejects NaN and Infinity, so
  // a fraction that reaches the reducer is always finite — and the reducer
  // clamps it into range regardless, because the tool paths are not the only
  // thing on the other end of this wire.
  /** Set a column's share of the grid width; siblings absorb the difference. */
  z.object({ type: z.literal('resize_column'), columnId: id, widthFraction: z.number() }),
  /** Set a pane's share of ITS COLUMN's height; the panes stacked with it absorb the difference. */
  z.object({ type: z.literal('resize_pane'), paneId: id, heightFraction: z.number() }),
  /** Relocate a pane to another column and/or index. `toIndex` omitted = append. */
  z.object({ type: z.literal('move_pane'), paneId: id, toColumnId: id, toIndex: z.number().int().optional() }),
  /** Reorder columns; the list is a PREFIX, not a required permutation (see `reorderColumns`). */
  z.object({ type: z.literal('reorder_columns'), columnIds: z.array(id).min(1).max(64) }),
]);

export type WorkspaceLayoutVerb = z.infer<typeof workspaceLayoutVerbSchema>;

export interface WorkspaceLayoutVerbOutcome {
  /** `null` = the session (still) has no grid. */
  state: WorkspaceState | null;
  /** Structural "did the transition run" — see module doc; NOT a byte diff. */
  applied: boolean;
}

const NOT_APPLIED = (state: WorkspaceState | null): WorkspaceLayoutVerbOutcome => ({ state, applied: false });

/**
 * Replaceable = unbound (picker), or bound to a resolved, non-terminal
 * target. Never a terminal (a running PTY loses its only surface — there is
 * no reattach UI) and never a pane whose mint is still in flight
 * (`targetId === null`): landing a different selection there means the
 * mint's own success callback later overwrites it with the stale pick.
 * The client store layers additional client-only guards on top — see the
 * module doc's divergence note.
 */
function isReplaceable(pane: PaneState): boolean {
  return pane.scope === null || (pane.scope.kind !== 'terminal' && pane.scope.targetId !== null);
}

/**
 * Apply one verb to one session's grid. THE shared reducer: the client's
 * optimistic apply and the server engine both call this and nothing else.
 * `workspaceId` seats a grid minted by `ensure`/`open_conversation` under the
 * right session id; every other verb ignores it.
 */
export function applyVerbLocal(
  state: WorkspaceState | null,
  workspaceId: string,
  verb: WorkspaceLayoutVerb,
): WorkspaceLayoutVerbOutcome {
  switch (verb.type) {
    case 'ensure': {
      if (state) return NOT_APPLIED(state);
      return {
        state: newWorkspace({ sessionId: workspaceId, paneId: verb.paneId, columnId: verb.columnId, scope: verb.scope }),
        applied: true,
      };
    }

    case 'split_right': {
      if (!state) return NOT_APPLIED(state);
      const next = splitRight(state, verb.fromPaneId, verb.newColumnId, verb.newPaneId);
      return { state: next, applied: next !== state };
    }

    case 'split_down': {
      if (!state) return NOT_APPLIED(state);
      const next = splitDown(state, verb.fromPaneId, verb.newPaneId);
      return { state: next, applied: next !== state };
    }

    case 'assign_pane': {
      if (!state) return NOT_APPLIED(state);
      const next = assignPane(state, verb.paneId, verb.scope);
      return { state: next, applied: next !== state };
    }

    case 'close_pane': {
      // The LAST pane deliberately no-ops (see `closePane`): emptying a
      // session ends it, which is a lifecycle act, never a layout verb.
      if (!state) return NOT_APPLIED(state);
      const next = closePane(state, verb.paneId);
      return { state: next, applied: next !== state };
    }

    case 'reset_pane': {
      if (!state) return NOT_APPLIED(state);
      const next = resetPane(state, verb.paneId);
      return { state: next, applied: next !== state };
    }

    case 'open_conversation': {
      if (!state) {
        return {
          state: newWorkspace({ sessionId: workspaceId, paneId: verb.newPaneId, columnId: verb.newColumnId, scope: verb.scope }),
          applied: true,
        };
      }
      if (verb.scope.targetId !== null) {
        const showing = paneShowing(state, verb.scope.targetId);
        if (showing) {
          const next = selectPane(state, showing.id);
          return { state: next, applied: next !== state };
        }
      }
      const panes = panesOf(state);
      // The structural policy, narrowed by whatever the caller asked for —
      // see the verb's own doc for why server-driven placement needs both.
      const canReplace = (pane: PaneState): boolean =>
        isReplaceable(pane) &&
        (verb.preferSplit !== true || pane.scope === null) &&
        (verb.excludeTargetId === undefined || pane.scope?.targetId !== verb.excludeTargetId);
      const active = panes.find((pane) => pane.id === state.activePaneId);
      const replaceable = active && canReplace(active) ? active : panes.find(canReplace);
      if (replaceable) {
        return { state: assignPane(state, replaceable.id, verb.scope), applied: true };
      }
      // Nothing replaceable (every pane a running terminal or an in-flight
      // mint) — open beside them instead of losing anything.
      const split = splitRight(state, state.activePaneId, verb.newColumnId, verb.newPaneId);
      if (split === state) return NOT_APPLIED(state);
      return { state: assignPane(split, verb.newPaneId, verb.scope), applied: true };
    }

    case 'replace_conversation': {
      if (!state) return NOT_APPLIED(state);
      const next = assignPaneShowing(state, verb.oldTargetId, verb.scope);
      return { state: next, applied: next !== state };
    }

    case 'resize_column': {
      if (!state) return NOT_APPLIED(state);
      const next = resizeColumn(state, verb.columnId, verb.widthFraction);
      return { state: next, applied: next !== state };
    }

    case 'resize_pane': {
      if (!state) return NOT_APPLIED(state);
      const next = resizePane(state, verb.paneId, verb.heightFraction);
      return { state: next, applied: next !== state };
    }

    case 'move_pane': {
      if (!state) return NOT_APPLIED(state);
      const next = movePane(state, verb.paneId, verb.toColumnId, verb.toIndex);
      return { state: next, applied: next !== state };
    }

    case 'reorder_columns': {
      if (!state) return NOT_APPLIED(state);
      const next = reorderColumns(state, verb.columnIds);
      return { state: next, applied: next !== state };
    }
  }
}

// ---------------------------------------------------------------------------
// Projections — the ONE serialize/reconcile pair between the rich state
// (blob shape) and what rows persist. See module doc.
// ---------------------------------------------------------------------------

/** What one pane row owns: identity, binding kind, binding target, height share. */
export interface LayoutGridPane {
  id: string;
  /** `null` = unbound picker pane. */
  kind: PaneKind | null;
  targetId: string | null;
  /**
   * Share of the column's height, `null` when the column is unsized. CANONICAL
   * `null` (never `undefined`): the store's content diff is a `JSON.stringify`
   * comparison, and `undefined` keys vanish from that string — so an absent
   * fraction and an explicit null would compare equal to a row that has one.
   */
  heightFraction: number | null;
}

/** What one column row owns: identity, width share, and its panes in `orderIndex` order. */
export interface LayoutGridColumn {
  id: string;
  panes: LayoutGridPane[];
  /** Share of the grid's width, `null` when the grid is unsized. Canonical null — see {@link LayoutGridPane.heightFraction}. */
  widthFraction: number | null;
}

/**
 * Project the rich state down to exactly what rows persist. Used by the verb
 * engine after every reduce AND by the legacy blob PUT (blob→rows through
 * this same function) — one shared reconcile, so the two writers cannot
 * disagree about the projection.
 */
export function gridFromWorkspaceState(state: WorkspaceState | PersistedWorkspaceState): LayoutGridColumn[] {
  return state.columns.map((column) => ({
    id: column.id,
    widthFraction: readFraction(column.widthFraction),
    panes: column.panes.map((pane) => ({
      id: pane.id,
      kind: pane.scope?.kind ?? null,
      targetId: pane.scope?.targetId ?? null,
      heightFraction: readFraction(pane.heightFraction),
    })),
  }));
}

/**
 * Re-hydrate a full `WorkspaceState` from persisted rows, using the
 * rolling-deploy blob (when present and matching) purely as the DISPLAY
 * side-channel: `name`/`agentPageId` per pane, plus `activePaneId`/
 * `pendingPickerPaneId` — none of which rows own. Structure (columns, pane
 * order, kind, targetId) always comes from `grid`; a blob disagreeing on
 * structure loses. `grid: []` falls back to the blob wholesale (rows not yet
 * promoted), and `null` means the session truly has no grid.
 *
 * A rows-bound pane the blob does not know (or knows with a different
 * target) gets an empty `name` and a `null` `agentPageId` — display fields,
 * repaired by the title-joining read path, never trusted as facts.
 */
export function workspaceStateFromGrid(params: {
  workspaceId: string;
  grid: LayoutGridColumn[];
  blob: PersistedWorkspaceState | null;
}): WorkspaceState | null {
  const { workspaceId, grid, blob } = params;
  if (grid.length === 0) {
    if (!blob || blob.id !== workspaceId) return null;
    return blob;
  }

  const blobPanes = new Map<string, PaneState>();
  if (blob && blob.id === workspaceId) {
    for (const column of blob.columns) {
      for (const pane of column.panes) blobPanes.set(pane.id, pane);
    }
  }

  // Fractions come from the ROWS, like every other structural fact — and stay
  // absent rather than explicitly null when unsized, so a hydrated grid is
  // byte-identical to one the reducer built from scratch.
  const columns: ColumnState[] = grid.map((column) => {
    const width = readFraction(column.widthFraction);
    return {
    id: column.id,
    ...(width !== null ? { widthFraction: width } : {}),
    panes: column.panes.map((pane) => {
      const stored = readFraction(pane.heightFraction);
      const height = stored !== null ? { heightFraction: stored } : {};
      if (pane.kind === null) return { id: pane.id, scope: null, ...height };
      const known = blobPanes.get(pane.id);
      const display =
        known?.scope && known.scope.kind === pane.kind && known.scope.targetId === pane.targetId
          ? { name: known.scope.name, agentPageId: known.scope.agentPageId }
          : { name: '', agentPageId: null };
      return {
        id: pane.id,
        scope: { kind: pane.kind, targetId: pane.targetId, ...display },
        ...height,
      };
    }),
    };
  });

  const paneIds = new Set(columns.flatMap((column) => column.panes.map((pane) => pane.id)));
  const activePaneId =
    blob && blob.id === workspaceId && paneIds.has(blob.activePaneId)
      ? blob.activePaneId
      : columns[0].panes[0].id;
  const pendingPickerPaneId =
    blob && blob.id === workspaceId && blob.pendingPickerPaneId !== null && paneIds.has(blob.pendingPickerPaneId)
      ? blob.pendingPickerPaneId
      : null;

  return { id: workspaceId, columns, activePaneId, pendingPickerPaneId };
}

/** The wire shape of a grid snapshot: the state's columns (view-state fields stay off the wire). */
export type WorkspaceLayoutGridDTO = PersistedColumnState[];
