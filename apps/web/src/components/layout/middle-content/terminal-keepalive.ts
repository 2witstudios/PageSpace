import { PageType } from '@pagespace/lib/utils/enums';

/**
 * Minimal structural view of a page-tree node — just what the keep-alive
 * planner needs. Kept local (rather than importing the full `TreePage`) so the
 * planning logic stays a pure, React-free module that can be unit-tested
 * without pulling in hooks.
 */
export interface TerminalTreeNode {
  id: string;
  type: string;
  children?: readonly TerminalTreeNode[] | null;
}

/**
 * Walk a page tree and collect the ids of every TERMINAL page. Used to know
 * which mounted terminals still exist (a trashed/closed terminal drops out of
 * the tree, so it drops out of this set and gets evicted).
 */
export function collectTerminalPageIds(
  tree: readonly TerminalTreeNode[] | null | undefined,
): string[] {
  const ids: string[] = [];
  const walk = (nodes: readonly TerminalTreeNode[] | null | undefined) => {
    if (!nodes) return;
    for (const node of nodes) {
      if (node.type === PageType.MACHINE) ids.push(node.id);
      if (node.children) walk(node.children);
    }
  };
  walk(tree);
  return ids;
}

export interface PlanMountedTerminalsInput {
  /** Active terminal page id, or null when the active page is not a terminal. */
  current: string | null;
  /** Previously-mounted terminal ids, most-recently-used first. */
  visited: readonly string[];
  /** Max terminals to keep mounted at once (the LRU bound). */
  max: number;
  /**
   * When provided, ids absent from this set are dropped from the plan — this is
   * how a trashed or closed terminal page is evicted (and unmounted). The
   * active `current` id is always retained regardless, since the user is
   * looking at it.
   */
  valid?: ReadonlySet<string> | null;
}

/**
 * Pure LRU planner for the keep-alive terminal set.
 *
 * Given the currently-active terminal (`current`), the previously-mounted set
 * (`visited`, most-recently-used first), and a bound (`max`), returns the new
 * ordered set of terminal ids that should stay mounted:
 *
 * - the active terminal is pinned to the front and never evicted;
 * - the remaining slots go to the most-recently-used terminals;
 * - anything past `max` is evicted (least-recently-used first);
 * - ids absent from `valid` (trashed/closed pages) are dropped.
 *
 * The consuming component mounts exactly this list and CSS-hides all but the
 * active one; ids that fall out of the list unmount (emitting a single
 * disconnect via the terminal's own teardown).
 */
export function planMountedTerminals({
  current,
  visited,
  max,
  valid,
}: PlanMountedTerminalsInput): string[] {
  const bound = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  // Active pinned to the front, then the previous set in MRU order.
  const ordered = current ? [current, ...visited] : [...visited];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const id of ordered) {
    if (seen.has(id)) continue;
    seen.add(id);
    // Evict trashed/closed pages — but never the active terminal.
    if (valid && !valid.has(id) && id !== current) continue;
    deduped.push(id);
  }
  // Pin the active page: it survives even a zero/one bound.
  const effectiveBound = current ? Math.max(1, bound) : bound;
  return deduped.slice(0, effectiveBound);
}
