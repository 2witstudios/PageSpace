/**
 * PACKING — where the next pane goes, and which way the container it joins
 * runs.
 *
 * Placement (`open` in `workspace-node-commands.ts`) decides WHETHER a newcomer
 * splits; this file decides WHAT it splits and WHICH WAY, and it exists because
 * "which way" used to be a constant. `OpenInput.axis` defaults to `row` and no
 * production caller has ever supplied it — every agent-opened pane therefore
 * split beside the last one, so a session that spawned three shells got three
 * columns, then four, until a human closed some (issue #2469). A constant is
 * the one answer that cannot be right twice in a row: the second pane wants to
 * be beside the first, and the third does not want to be beside those two.
 *
 * **The rule is the rectangle, not the count.** A pane is split along its
 * LONGER EDGE — the standard tiling answer, and the only one that stays right
 * as a workspace is resized, as shares are dragged, and at every depth. "Go
 * vertical once there are two columns" is what it happens to do on an untouched
 * grid, which is what the issue asked for; it is not what it is.
 *
 * The server cannot see pixels, so a rectangle here is a FRACTION of the
 * workspace ({@link paneRects}) scaled by a nominal viewport shape
 * ({@link NOMINAL_VIEWPORT_ASPECT}). That approximation is stated rather than
 * hidden, and it is sound for the decision being made: the panes it compares
 * are all inside the same viewport, so a workspace that is wider or narrower
 * than the nominal one moves every pane's aspect in the same direction and only
 * ever changes the answer for panes that were already close to square — where
 * both answers are good ones.
 *
 * Pure, and shared by the browser and the server like every other decision in
 * this model: the client applies the identical split optimistically, so a
 * layout it draws and a layout the write funnel commits cannot disagree about
 * which way anything went.
 */

import { currentShares } from './workspace-fractions';
import {
  childrenOf,
  rootOf,
  type NodeAxis,
  type PaneNode,
  type WorkspaceNode,
} from './workspace-node';

/**
 * The workspace's assumed width-to-height ratio — the one number this file
 * cannot derive.
 *
 * A pane's stored geometry is a share of its container, so the tree knows a
 * pane is half as wide as the workspace and knows nothing about whether the
 * workspace is a widescreen monitor or a phone. 16:9 is the shape the grid is
 * overwhelmingly drawn at (the pane surface is the desktop layout's main
 * column) and it is the shape that makes the FIRST split horizontal, which is
 * both what the model this replaces did and what a reader expects.
 *
 * It biases toward columns, deliberately: a workspace narrower than this splits
 * vertically sooner, which is the right failure — a too-narrow pane is unusable
 * in a way a too-short one is not, because terminal output and chat both wrap.
 */
export const NOMINAL_VIEWPORT_ASPECT = 16 / 9;

/** A pane's share of the workspace, as fractions of its width and height. */
export interface PaneRect {
  /** 0–1. The whole workspace is 1. */
  width: number;
  /** 0–1. */
  height: number;
}

/**
 * Every pane's rectangle, derived from the tree the way the renderer derives it
 * from the same rows.
 *
 * `currentShares` is the shared rule (`ContainerGroup` renders a stored
 * `fraction` and falls back to an even split; so does this), imported rather
 * than re-derived — a second sizing rule here would make the axis this file
 * chooses disagree with the shape the user is actually looking at as soon as
 * anyone dragged a handle.
 *
 * Total on cyclic input, like every other walk over this model: a flat parent
 * pointer can express a cycle, and placement runs before the write that would
 * have rejected one.
 */
export function paneRects(nodes: readonly WorkspaceNode[]): Map<string, PaneRect> {
  const rects = new Map<string, PaneRect>();
  const root = rootOf(nodes);
  if (root === undefined) return rects;

  const seen = new Set<string>([root.id]);
  const walk = (parentId: string, axis: NodeAxis, rect: PaneRect): void => {
    const children = childrenOf(nodes, parentId).filter((child) => !seen.has(child.id));
    if (children.length === 0) return;
    const shares = currentShares(children.map((child) => (child.nodeType === 'root' ? null : child.fraction)));
    children.forEach((child, index) => {
      seen.add(child.id);
      const share = shares[index];
      const childRect: PaneRect =
        axis === 'row'
          ? { width: rect.width * share, height: rect.height }
          : { width: rect.width, height: rect.height * share };
      if (child.nodeType === 'pane') rects.set(child.id, childRect);
      else if (child.nodeType === 'split') walk(child.id, child.axis, childRect);
    });
  };

  walk(root.id, root.axis, { width: 1, height: 1 });
  return rects;
}

/** A rectangle's area as it is actually drawn — the aspect scales every width alike, so it cancels in comparisons. */
function areaOf(rect: PaneRect): number {
  return rect.width * rect.height;
}

/**
 * WHICH WAY to split this pane: along its longer edge as drawn.
 *
 * `row` on a tie, which is what makes the first split of a fresh workspace
 * horizontal — the direction `split_right` gave the grid this model replaces,
 * and the direction the old constant default hard-coded for every split.
 *
 * A pane the tree does not hold answers `row` rather than throwing: this is a
 * preference feeding a placement that will refuse the unknown node itself, with
 * a code that says so.
 */
export function splitAxisFor(nodes: readonly WorkspaceNode[], paneId: string): NodeAxis {
  const rect = paneRects(nodes).get(paneId);
  if (rect === undefined) return 'row';
  return rect.width * NOMINAL_VIEWPORT_ASPECT >= rect.height ? 'row' : 'column';
}

/**
 * How close two panes' areas may be and still count as the same size. Well
 * above float noise and well below any share a user would drag to.
 */
const AREA_TOLERANCE = 1e-6;

/**
 * WHICH PANE to split — the biggest rectangle on screen, with the pane the user
 * is looking at preferred whenever it is one of them.
 *
 * The active pane used to win outright (`active ?? panes[0]`), and that is the
 * other half of issue #2469's accumulation. Focus does not move to a shell an
 * agent spawns, so every spawn in a session split THE SAME pane — the one
 * holding the conversation the agent is running in — halving it each time and
 * nesting one container deeper each time, toward `MAX_DEPTH`, while the rest of
 * the grid sat untouched. Splitting the largest pane instead keeps the tree
 * balanced: depth grows with the LOGARITHM of the pane count, so the cap stops
 * being reachable by ordinary use.
 *
 * The active pane is still honoured whenever it is among the largest, which is
 * every case where "beside where I am looking" is a thing the layout can
 * actually offer — a fresh workspace, an even grid. Once it is the smallest
 * rectangle on screen, packing into it is not honouring the user's focus; it is
 * subdividing the one pane they are trying to read.
 *
 * Render order breaks a tie, so an even grid fills left-to-right, top-to-bottom
 * rather than in some order derived from the row layout.
 */
export function splitHostPane(
  nodes: readonly WorkspaceNode[],
  panes: readonly PaneNode[],
  activeNodeId?: string,
): PaneNode | undefined {
  if (panes.length === 0) return undefined;
  const rects = paneRects(nodes);
  const area = (pane: PaneNode): number => areaOf(rects.get(pane.id) ?? { width: 1, height: 1 });

  let largest = panes[0];
  let largestArea = area(largest);
  for (const pane of panes) {
    const candidate = area(pane);
    if (candidate > largestArea + AREA_TOLERANCE) {
      largest = pane;
      largestArea = candidate;
    }
  }

  const active = panes.find((pane) => pane.id === activeNodeId);
  if (active !== undefined && area(active) >= largestArea - AREA_TOLERANCE) return active;
  return largest;
}
