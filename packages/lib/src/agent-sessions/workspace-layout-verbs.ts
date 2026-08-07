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
  }
}

// ---------------------------------------------------------------------------
// Projections — the ONE serialize/reconcile pair between the rich state
// (blob shape) and what rows persist. See module doc.
// ---------------------------------------------------------------------------

/** What one pane row owns: identity, binding kind, binding target. */
export interface LayoutGridPane {
  id: string;
  /** `null` = unbound picker pane. */
  kind: PaneKind | null;
  targetId: string | null;
}

/** What one column row owns: identity plus its panes in `orderIndex` order. */
export interface LayoutGridColumn {
  id: string;
  panes: LayoutGridPane[];
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
    panes: column.panes.map((pane) => ({
      id: pane.id,
      kind: pane.scope?.kind ?? null,
      targetId: pane.scope?.targetId ?? null,
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

  const columns: ColumnState[] = grid.map((column) => ({
    id: column.id,
    panes: column.panes.map((pane) => {
      if (pane.kind === null) return { id: pane.id, scope: null };
      const known = blobPanes.get(pane.id);
      const display =
        known?.scope && known.scope.kind === pane.kind && known.scope.targetId === pane.targetId
          ? { name: known.scope.name, agentPageId: known.scope.agentPageId }
          : { name: '', agentPageId: null };
      return {
        id: pane.id,
        scope: { kind: pane.kind, targetId: pane.targetId, ...display },
      };
    }),
  }));

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
