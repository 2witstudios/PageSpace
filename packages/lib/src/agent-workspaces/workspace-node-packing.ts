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
 * workspace ({@link paneRects}) scaled by the surface's measured shape
 * ({@link NOMINAL_VIEWPORT_ASPECT}). That approximation is stated rather than
 * hidden, and it is the only place a real screen enters this file at all. It
 * decides nothing on a grid of halves, quarters and eighths — those answer the
 * same for any ratio between 1 and 2 — and everything for a container of
 * THREE, which the packing path reaches once a CLOSE is in the mix (three
 * opens, a close, three more opens is the shortest way there; opens alone keep
 * every container at two children and every share a power of two).
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
 * The PANE SURFACE's width-to-height ratio — the one number this file cannot
 * derive, so it is MEASURED rather than argued about.
 *
 * A pane's stored geometry is a share of its container, so the tree knows a
 * pane is half as wide as the workspace and knows nothing about how many pixels
 * that is. {@link splitAxisFor} needs the surface's aspect to turn those shares
 * back into a shape: a pane is wider than it is tall exactly when
 * `width × (surfaceWidth / surfaceHeight) ≥ height`.
 *
 * **The surface is not the screen.** It is the agents layout's main column,
 * with the sidebar and the top chrome already taken out. Measured in the
 * running app — the `session-panes` element's own box, sidebar open:
 *
 *     viewport      surface       aspect
 *     1280 x  800   1045 x  702    1.49
 *     1512 x  916   1235 x  818    1.51
 *     2560 x 1440   2094 x 1342    1.56
 *     1920 x 1080   1569 x  982    1.60
 *
 * So 3:2 — and the useful part is how NARROW that spread is: the chrome scales
 * with the window, so the surface stays near 3:2 from a small laptop to a
 * 27-inch monitor. Collapsing the sidebar widens it, which is a state the user
 * chose and which moves the answer only for panes already on the boundary.
 *
 * **16:9 was the screen's shape and overstated the surface by 11–19%; a later
 * cut over-corrected to 4:3 and understated it by about as much.** Neither
 * error shows up often — a search over drag-free open/close sequences finds
 * exactly ONE shape any of the three answer differently (a pane a third of the
 * width at half the height), and 16:9 and 3:2 agree even on that one. What the
 * measurement buys is not a behaviour change; it is that the number is now a
 * fact about this app rather than a preference, so the next person to doubt it
 * measures again instead of arguing. The behaviour it does change is the
 * DRAGGED case, where the aspect is the whole of the answer: a pane given 60%
 * of the width and the full height is 627x702 on a 1045x702 surface, and 16:9
 * called it wide.
 */
export const NOMINAL_VIEWPORT_ASPECT = 3 / 2;

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
 * **STRICTLY wider, or it goes down.** A pane the rule cannot separate is
 * square, and a square pane is the one case where the preference underneath
 * this whole file has to break the tie: a too-narrow pane stops showing a line
 * of terminal output or chat, a too-short one still shows one. That is not
 * theoretical — a row of three panes inside a column is exactly square at 3:2,
 * and answering `row` there grows it to a row of FOUR, thinner again, which is
 * the accumulation this file exists to stop. On the narrowest surface measured
 * (1.49) the real pixels agree: that pane is taller than it is wide.
 *
 * The first split of a fresh workspace is still `row` — a pane holding the
 * whole surface is genuinely wider than it is tall, by the whole of the aspect,
 * so it never reaches the tie.
 *
 * A pane the tree does not hold answers `row` rather than throwing: this is a
 * preference feeding a placement that will refuse the unknown node itself, with
 * a code that says so.
 */
export function splitAxisFor(nodes: readonly WorkspaceNode[], paneId: string): NodeAxis {
  const rect = paneRects(nodes).get(paneId);
  if (rect === undefined) return 'row';
  return rect.width * NOMINAL_VIEWPORT_ASPECT > rect.height ? 'row' : 'column';
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
