/**
 * THE PACKING RULE — which pane the next one splits, and which way.
 *
 * These are facts about a POLICY, not about the data: nothing here would be
 * wrong under a different rule, and the tests say what the rule is rather than
 * what a tree can hold. The invariants the tree itself defends
 * (`MAX_DEPTH`, `MAX_NODES`, well-formed containers) belong to
 * `workspace-node-validate.test.ts` and are asserted through the commands, not
 * here.
 *
 * The suite exists because the two decisions it covers used to be constants —
 * `'row'` for the direction and `active ?? panes[0]` for the host — and issue
 * #2469 is what both of them add up to: every shell an agent spawned became a
 * new column carved out of the same pane, until a human closed some.
 */
import { describe, it, expect } from 'vitest';

import {
  NOMINAL_VIEWPORT_ASPECT,
  paneRects,
  splitAxisFor,
  splitHostPane,
} from '../workspace-node-packing';
import type { PaneNode, RootNode, SplitNode, WorkspaceNode } from '../workspace-node';

function root(axis: 'row' | 'column' = 'row'): RootNode {
  return { nodeType: 'root', id: 'root-1', parentId: null, position: 0, axis };
}

function container(id: string, parentId: string, position: number, axis: 'row' | 'column'): SplitNode {
  return { nodeType: 'split', id, parentId, position, axis };
}

function pane(id: string, parentId: string, position: number, fraction?: number): PaneNode {
  return {
    nodeType: 'pane',
    id,
    parentId,
    position,
    target: null,
    ...(fraction === undefined ? {} : { fraction }),
  };
}

/** The panes of a tree, in the render order `open` walks them in. */
function panesOf(nodes: readonly WorkspaceNode[]): PaneNode[] {
  return nodes.filter((node): node is PaneNode => node.nodeType === 'pane');
}

describe('paneRects', () => {
  it('should give a lone pane the whole workspace', () => {
    const nodes = [root(), pane('a', 'root-1', 0)];
    expect(paneRects(nodes).get('a')).toEqual({ width: 1, height: 1 });
  });

  it('should divide the axis the container runs along, and leave the other alone', () => {
    const nodes = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    expect(paneRects(nodes).get('a')).toEqual({ width: 0.5, height: 1 });

    const stacked = [root('column'), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    expect(paneRects(stacked).get('a')).toEqual({ width: 1, height: 0.5 });
  });

  it('should honour the shares a user dragged, because the axis has to match what they are looking at', () => {
    const nodes = [root(), pane('a', 'root-1', 0, 0.8), pane('b', 'root-1', 1, 0.2)];
    const rects = paneRects(nodes);
    expect(rects.get('a')?.width).toBeCloseTo(0.8, 5);
    expect(rects.get('b')?.width).toBeCloseTo(0.2, 5);
  });

  it('should compound through nesting', () => {
    const nodes = [
      root(),
      pane('a', 'root-1', 0),
      container('col', 'root-1', 1, 'column'),
      pane('b', 'col', 0),
      pane('c', 'col', 1),
    ];
    expect(paneRects(nodes).get('b')).toEqual({ width: 0.5, height: 0.5 });
  });

  it('should answer nothing at all for a workspace with no tree', () => {
    expect(paneRects([]).size).toBe(0);
  });

  it('should be total on a cycle, because placement runs before the write that would reject one', () => {
    const nodes: WorkspaceNode[] = [
      root(),
      container('x', 'y', 0, 'row'),
      container('y', 'x', 0, 'row'),
      pane('a', 'root-1', 0),
    ];
    expect(paneRects(nodes).get('a')).toEqual({ width: 1, height: 1 });
  });
});

describe('splitAxisFor', () => {
  it('should split the whole workspace BESIDE, because it is wider than it is tall', () => {
    const nodes = [root(), pane('a', 'root-1', 0)];
    expect(splitAxisFor(nodes, 'a')).toBe('row');
  });

  it('should split a half-width column BELOW — the answer the old constant could never give', () => {
    // This is issue #2469 in one assertion: the third pane of a session used to
    // become a third column here.
    const nodes = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    expect(splitAxisFor(nodes, 'a')).toBe('column');
  });

  it('should turn back to BESIDE once a pane is short enough', () => {
    // Half the width and half the height: on any surface wider than it is tall
    // that rectangle is wider than it is tall too, so its longer edge is
    // horizontal again. That alternation is what produces a grid, not a stack.
    const nodes = [
      root(),
      pane('a', 'root-1', 0),
      container('col', 'root-1', 1, 'column'),
      pane('b', 'col', 0),
      pane('c', 'col', 1),
    ];
    expect(splitAxisFor(nodes, 'b')).toBe('row');
  });

  it('should follow a dragged share rather than the pane count', () => {
    // Two columns, but one of them is nearly the whole width — so it still has
    // room beside, and the rule says so where a count-of-columns rule could not.
    const nodes = [root(), pane('a', 'root-1', 0, 0.9), pane('b', 'root-1', 1, 0.1)];
    expect(splitAxisFor(nodes, 'a')).toBe('row');
    expect(splitAxisFor(nodes, 'b')).toBe('column');
  });

  it('should turn a dragged pane DOWN once it is taller than it is wide', () => {
    // 60% of the width and the full height is 627x702 on a 1045x702 surface —
    // taller, so `column`. This is the boundary the constant sits closest to:
    // the flip is at two thirds of the width.
    const nodes = [root(), pane('wide', 'root-1', 0, 0.6), pane('narrow', 'root-1', 1, 0.4)];
    expect(splitAxisFor(nodes, 'wide')).toBe('column');

    const wider = [root(), pane('wide', 'root-1', 0, 0.7), pane('narrow', 'root-1', 1, 0.3)];
    expect(splitAxisFor(wider, 'wide')).toBe('row');
  });

  it('should split a THIRD of the width DOWN whether or not it has the full height', () => {
    // A third of the width at FULL height is `column` for any ratio under 3 —
    // this case pins the shape, not the constant.
    const thirds = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1), pane('c', 'root-1', 2)];
    expect(splitAxisFor(thirds, 'a')).toBe('column');

    // Halve its height and it lands EXACTLY on the boundary — a third of the
    // width against half the height is square at 3:2 — which is where the tie
    // rule earns its keep. Answering `row` here grows a row of three into a row
    // of FOUR, thinner again, which is the accumulation this file exists to
    // stop; the narrowest measured surface (1.49) says the pane really is
    // taller than it is wide. THE constant-sensitive case in the whole file:
    // 16/9 answers `row`, and so does 3:2 with a `>=` comparison.
    const halved = [
      root(),
      container('col', 'root-1', 0, 'column'),
      pane('tall', 'col', 0),
      pane('under', 'col', 1),
      pane('b', 'root-1', 1),
      pane('c', 'root-1', 2),
    ];
    expect(splitAxisFor(halved, 'tall')).toBe('column');
  });

  it('should still take the FIRST split of a fresh workspace beside, tie rule or not', () => {
    // The tie goes down, and a lone pane never reaches the tie: it is wider
    // than it is tall by the whole of the aspect.
    const nodes = [root(), pane('only', 'root-1', 0)];
    expect(splitAxisFor(nodes, 'only')).toBe('row');
  });

  it('should keep the constant inside the range the surface was MEASURED at', () => {
    // 1.49 to 1.60 across viewports from a 1280x800 laptop to a 27-inch monitor
    // (the table on the constant's own doc). A value outside that is not an
    // approximation of this app's layout any more, whatever else it might be —
    // and the two values this file has already had, 16/9 and 4/3, both fall
    // outside it.
    expect(NOMINAL_VIEWPORT_ASPECT).toBeGreaterThanOrEqual(1.49);
    expect(NOMINAL_VIEWPORT_ASPECT).toBeLessThanOrEqual(1.6);
  });

  it('should answer `row` for a pane the tree does not hold, leaving the refusal to the placement', () => {
    expect(splitAxisFor([root()], 'ghost')).toBe('row');
  });
});

describe('splitHostPane', () => {
  it('should honour the active pane when it is one of the largest', () => {
    const nodes = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    expect(splitHostPane(nodes, panesOf(nodes), 'b')?.id).toBe('b');
  });

  it('should NOT subdivide the active pane once it is the smallest rectangle on screen', () => {
    // The accumulation half of #2469. Focus never moves to a shell an agent
    // spawns, so every spawn in a session split the same pane — the one holding
    // the conversation the agent runs in — halving it each time.
    const nodes = [
      root(),
      pane('big', 'root-1', 0, 0.75),
      container('col', 'root-1', 1, 'column'),
      pane('tiny', 'col', 0),
      pane('other', 'col', 1),
    ];
    expect(splitHostPane(nodes, panesOf(nodes), 'tiny')?.id).toBe('big');
  });

  it('should take the largest pane when nothing is active', () => {
    const nodes = [root(), pane('a', 'root-1', 0, 0.2), pane('b', 'root-1', 1, 0.8)];
    expect(splitHostPane(nodes, panesOf(nodes))?.id).toBe('b');
  });

  it('should break a tie in render order, so an even grid fills left to right', () => {
    const nodes = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1), pane('c', 'root-1', 2)];
    expect(splitHostPane(nodes, panesOf(nodes))?.id).toBe('a');
  });

  it('should ignore an active id the tree does not hold', () => {
    const nodes = [root(), pane('a', 'root-1', 0, 0.2), pane('b', 'root-1', 1, 0.8)];
    expect(splitHostPane(nodes, panesOf(nodes), 'ghost')?.id).toBe('b');
  });

  it('should answer nothing for an empty grid, which places into the root instead', () => {
    expect(splitHostPane([root()], [])).toBeUndefined();
  });
});
