/**
 * The optimistic verb queue's pure half — everything the client store does to
 * reconcile "what the server last told me" with "what I have done since",
 * expressed without zustand, React, or IO so it can be exhaustively tested.
 *
 * The model is one equation, and the store's whole job is to keep it true:
 *
 *     rendered = replayPending(serverSnapshot, unackedVerbs)
 *
 * `serverSnapshot` is the last `{rev, grid}` the server handed us (mount GET,
 * a verb POST's own 200/409 body, or a `workspace:updated` broadcast);
 * `unackedVerbs` is the FIFO of verbs applied locally whose POST has not yet
 * come back. Every arrival of new truth replaces the snapshot and REPLAYS the
 * queue on top — which is why a 409 is not an error here but simply the
 * server handing us a newer snapshot to replay against.
 *
 * **Why replay is safe.** Pane and column ids are CLIENT-MINTED and carried
 * in the verb payload, so a verb that already landed server-side is
 * detectable structurally: its minted ids are already in the snapshot
 * ({@link verbAlreadyLanded}). That check is what makes replay idempotent for
 * the four verbs that MINT identity — `ensure`, `split_right`, `split_down`,
 * and `open_conversation`'s split branch — replaying one blind would splice a
 * second column or pane carrying an id that already exists. Every other verb is
 * naturally idempotent: assigning the same scope to the same pane, closing an
 * already-closed pane, resetting an already-unbound pane and repointing an
 * already-repointed target all reduce to the same state.
 *
 * **What is deliberately NOT in the equation**: `activePaneId` and
 * `pendingPickerPaneId`. Focus is client-local view state that no row owns
 * (the #2048 machines decision — focus does not restore cross-device), so
 * {@link adoptServerGrid} does not try to recover it from the wire; the store
 * overlays its own focus on top of whatever structure comes back.
 */

import type { PersistedColumnState } from '@pagespace/lib/agent-workspaces/contract';
import { applyVerbLocal, panesOf, type WorkspaceLayoutVerb, type WorkspaceState } from './pane-reducer';

/**
 * One verb applied locally and not yet acknowledged by the server.
 *
 * `baseRev` records the rev the verb was REDUCED against, for diagnostics and
 * ordering intent. It is deliberately not what gets sent: the queue is
 * strictly serial, so by the time op N leaves the wire, ops 0..N-1 have
 * already advanced the rev, and the store re-stamps `baseRev` from the
 * current snapshot at send time.
 */
export interface PendingVerbOp {
  opId: string;
  baseRev: number;
  verb: WorkspaceLayoutVerb;
}

/**
 * The pane id a verb MINTS (as opposed to the ones it addresses), if any.
 *
 * Every verb is named and the fall-through assigns to `never`, for the same
 * reason `paneScopesOfVerb` does it: a `default: return null` would make a NEW
 * minting verb answer "mints nothing", so {@link verbAlreadyLanded} would say
 * it had not landed, {@link replayPending} would re-apply it after a 409, and
 * the reducer would splice a second pane carrying an id the server already has
 * — a compound-PK violation on the next write, surfacing as a 500 five retries
 * later when the queue gives up and discards the user's work. The cost of
 * forgetting has to be a build failure.
 */
function mintedPaneId(verb: WorkspaceLayoutVerb): string | null {
  switch (verb.type) {
    case 'ensure':
      return verb.paneId;
    case 'split_right':
    case 'split_down':
    case 'open_conversation':
      return verb.newPaneId;

    // Address panes that already exist; mint nothing.
    case 'assign_pane':
    case 'close_pane':
    case 'reset_pane':
    case 'replace_conversation':
    case 'resize_column':
    case 'resize_pane':
    case 'move_pane':
    case 'reorder_columns':
      return null;

    default: {
      const _exhaustive: never = verb;
      void _exhaustive;
      return null;
    }
  }
}

/** The column id a verb MINTS, if any. Exhaustive for the same reason as above. */
function mintedColumnId(verb: WorkspaceLayoutVerb): string | null {
  switch (verb.type) {
    case 'ensure':
      return verb.columnId;
    case 'split_right':
    case 'open_conversation':
      return verb.newColumnId;

    // `split_down` mints a PANE inside the column it split from, never a column.
    case 'split_down':
    case 'assign_pane':
    case 'close_pane':
    case 'reset_pane':
    case 'replace_conversation':
    case 'resize_column':
    case 'resize_pane':
    case 'move_pane':
    case 'reorder_columns':
      return null;

    default: {
      const _exhaustive: never = verb;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Has this verb's CREATION already landed in `state`? True only for the verbs
 * that mint identity, and only when the minted id is already present — the
 * precise, id-based idempotency check that client-minted ids buy us.
 *
 * A verb whose creation branch never ran (`open_conversation` that resolved
 * to a focus or an assign, say) answers `false` and gets replayed, which is
 * correct: those branches are idempotent.
 */
export function verbAlreadyLanded(state: WorkspaceState | null, verb: WorkspaceLayoutVerb): boolean {
  if (state === null) return false;
  // `ensure` only ever creates, and only into an empty grid — a non-null
  // state means its work is done (the reducer agrees; this is the explicit
  // statement of it).
  if (verb.type === 'ensure') return true;

  const paneId = mintedPaneId(verb);
  if (paneId !== null && panesOf(state).some((pane) => pane.id === paneId)) return true;
  const columnId = mintedColumnId(verb);
  if (columnId !== null && state.columns.some((column) => column.id === columnId)) return true;
  return false;
}

/**
 * Re-apply every unacked verb on top of a snapshot, in order. The ONE way the
 * store derives what it renders — used after a local mutation, after an ack,
 * after a 409, and after a remote `workspace:updated`.
 */
export function replayPending(
  base: WorkspaceState | null,
  workspaceId: string,
  pending: readonly PendingVerbOp[],
): WorkspaceState | null {
  let state = base;
  for (const op of pending) {
    if (verbAlreadyLanded(state, op.verb)) continue;
    state = applyVerbLocal(state, workspaceId, op.verb).state;
  }
  return state;
}

/**
 * Turn a wire grid (`{rev, grid}` from the GET, a verb response, or a
 * broadcast) into a `WorkspaceState` the reducer can run on. `null`/empty is
 * a session with no grid at all, which the store renders as "no workspace".
 *
 * Focus is filled with a placeholder (the first pane) rather than guessed:
 * the store overlays the user's real focus afterwards. See the module doc.
 */
export function adoptServerGrid(
  workspaceId: string,
  grid: readonly PersistedColumnState[] | null | undefined,
): WorkspaceState | null {
  if (!grid || grid.length === 0) return null;
  // Fractions ride along as first-class structure (issue #2208) — they are
  // rows, not view state, so unlike focus they come straight off the wire. An
  // unsized container carries no key at all, which is what keeps a hydrated
  // grid byte-identical to one the reducer built.
  const columns = grid.map((column) => ({
    id: column.id,
    ...(typeof column.widthFraction === 'number' ? { widthFraction: column.widthFraction } : {}),
    panes: column.panes.map((pane) => ({
      id: pane.id,
      scope: pane.scope,
      ...(typeof pane.heightFraction === 'number' ? { heightFraction: pane.heightFraction } : {}),
    })),
  }));
  const first = columns.find((column) => column.panes.length > 0);
  if (!first) return null;
  return {
    id: workspaceId,
    columns: columns.filter((column) => column.panes.length > 0),
    activePaneId: first.panes[0].id,
    pendingPickerPaneId: null,
  };
}
