/**
 * Pure decision logic for task ordering.
 *
 * Task order has a single source of truth: `pages.position` on the task's linked
 * page. `task_items` carries no position of its own — it used to, and the two rails
 * silently diverged (users reordered pages, AI tools reordered task rows, neither saw
 * the other; see #2143).
 *
 * These functions decide WHAT the new order is. The imperative shells
 * (`reorderTaskPeers` in `lib/ai/tools/task-helpers.ts`, the tasks routes) perform
 * the reads and the writes.
 */

export type SortOrder = 'asc' | 'desc';

/** The minimum shape needed to order tasks: the linked page's position, plus a stable id. */
export interface OrderedTaskLike {
  readonly id: string;
  readonly page?: { readonly position: number } | null;
}

/**
 * Comparator over `pages.position`, with `id` as the tiebreaker.
 *
 * The id tiebreaker mirrors the SQL `asc(taskItems.id)` tiebreaker the GET route
 * applies: two tasks sharing a position otherwise have no guaranteed order across
 * repeated LIMIT/OFFSET calls, so paging could skip or duplicate rows. Because it
 * exists for stability rather than user intent, it stays ascending under `desc`.
 *
 * A task whose `page` relation is missing has no position at all. It sorts last in
 * both directions rather than being coerced to 0 — coercion is what made the old
 * `?? task.position` fallbacks look meaningful when they never were.
 */
export function compareByPagePosition(
  a: OrderedTaskLike,
  b: OrderedTaskLike,
  sortOrder: SortOrder = 'asc',
): number {
  const posA = a.page?.position;
  const posB = b.page?.position;

  if (posA === undefined || posB === undefined) {
    if (posA !== posB) return posA === undefined ? 1 : -1;
  } else if (posA !== posB) {
    return sortOrder === 'desc' ? posB - posA : posA - posB;
  }

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A sibling candidate for a move: a task list child page and its current position. */
export interface TaskPeer {
  readonly id: string;
  readonly position: number;
}

export interface TaskMoveSingle {
  readonly kind: 'single';
  /** The position to write on the moved page. */
  readonly position: number;
  /** The clamped slot the task ends up in. */
  readonly index: number;
}

export interface TaskMoveDensify {
  readonly kind: 'densify';
  /** Every sibling (moved task included) with its new dense position. */
  readonly positions: ReadonlyArray<TaskPeer>;
  readonly index: number;
}

export type TaskMovePlan = TaskMoveSingle | TaskMoveDensify;

export interface ComputeTaskMovePositionInput {
  /**
   * All task list children ordered by `pages.position` ascending. May include the
   * moved task — it is excluded before the target slot is resolved, so callers can
   * pass the result of a plain "children of this list" query.
   */
  readonly peers: ReadonlyArray<TaskPeer>;
  readonly movedId: string;
  /** Destination slot among the *other* tasks: 0 = first, peers.length = last. */
  readonly targetIndex: number;
}

/**
 * Resolve an index-based move (what the AI `reorder_task` tool and the REST
 * `{position}` field express) into a `pages.position` write.
 *
 * The common case writes one row: step below the first peer, above the last, or
 * split the gap between two neighbours — the same arithmetic the drag handler in
 * TaskListView already performs client-side.
 *
 * `pages.position` is `real` (float4, ~7 significant digits), so repeated midpoint
 * splits eventually exhaust the gap. When no float4 value sits strictly between the
 * two neighbours — including when they already share a position — the plan escalates
 * to re-densifying every sibling to 0..n-1, which restores splittable gaps. Detection
 * uses `Math.fround` because that, not the float64 midpoint, is the value Postgres
 * will actually store.
 */
export function computeTaskMovePosition(input: ComputeTaskMovePositionInput): TaskMovePlan {
  const others = input.peers.filter(p => p.id !== input.movedId);
  const index = Math.max(0, Math.min(Math.trunc(input.targetIndex), others.length));

  const before = index > 0 ? others[index - 1] : undefined;
  const after = index < others.length ? others[index] : undefined;

  if (before === undefined) {
    // Includes the empty-list case: first (and only) slot anchors at 0.
    return { kind: 'single', position: after === undefined ? 0 : after.position - 1, index };
  }

  if (after === undefined) {
    return { kind: 'single', position: before.position + 1, index };
  }

  const midpoint = Math.fround((before.position + after.position) / 2);
  if (midpoint > Math.fround(before.position) && midpoint < Math.fround(after.position)) {
    return { kind: 'single', position: midpoint, index };
  }

  const ordered = [...others.slice(0, index).map(p => p.id), input.movedId, ...others.slice(index).map(p => p.id)];
  return {
    kind: 'densify',
    index,
    positions: ordered.map((id, i) => ({ id, position: i })),
  };
}
