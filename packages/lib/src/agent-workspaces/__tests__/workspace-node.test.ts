/**
 * The workspace NODE model's tree helpers — the flat-list primitives every
 * later layer (validate, algebra, commands) composes.
 *
 * The model is a FLAT list, not a nested tree, and that is the decision this
 * suite is written against: rows are flat, the wire is flat, and it is the only
 * shape in which "detached" is not a second bucket alongside the tree. Nesting
 * is derived for rendering; the price is that cycles become representable, which
 * is `validateTree`'s job next door, not the type's.
 *
 * Sibling of `workspace-layout-verbs.test.ts`, which covers the two-level
 * column/pane model this replaces. Both exist during the migration window.
 */
import { describe, it, expect } from 'vitest';
import {
  childrenOf,
  descendantsOf,
  detachedOf,
  findNode,
  removeNodes,
  rootOf,
  upsertNodes,
  type PaneNode,
  type RootNode,
  type SplitNode,
  type WorkspaceNode,
} from '../workspace-node';

function root(): RootNode {
  return { nodeType: 'root', id: 'root-1', parentId: null, position: 0, axis: 'row' };
}

function split(id: string, parentId: string, position: number): SplitNode {
  return { nodeType: 'split', id, parentId, position, axis: 'column' };
}

function pane(id: string, parentId: string | null, position: number): PaneNode {
  return { nodeType: 'pane', id, parentId, position, target: { kind: 'chat', id: `conv-${id}` } };
}

describe('childrenOf', () => {
  it('should return a parent’s children ordered by position, whatever order the list is in', () => {
    const nodes = [root(), pane('b', 'root-1', 1), pane('c', 'root-1', 2), pane('a', 'root-1', 0)];
    expect(childrenOf(nodes, 'root-1').map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('should not count a detached pane as a child of anything', () => {
    const nodes = [root(), pane('attached', 'root-1', 0), pane('detached', null, 0)];
    expect(childrenOf(nodes, 'root-1').map((n) => n.id)).toEqual(['attached']);
  });

  it('should be empty for an id that resolves to nothing, rather than throwing', () => {
    expect(childrenOf([root()], 'no-such-node')).toEqual([]);
  });
});

describe('rootOf', () => {
  it('should find the root by its type, not by its null parent', () => {
    const nodes = [pane('detached', null, 0), root(), pane('attached', 'root-1', 0)];
    expect(rootOf(nodes)?.id).toBe('root-1');
  });

  it('should find nothing in a list that has no root', () => {
    expect(rootOf([pane('orphan', null, 0)])).toBeUndefined();
  });
});

describe('detachedOf', () => {
  it('should return panes parked outside the tree, and never the root', () => {
    const nodes = [root(), pane('attached', 'root-1', 0), pane('parked', null, 0)];
    expect(detachedOf(nodes).map((n) => n.id)).toEqual(['parked']);
  });

  it('should order parked panes by position, so the sidebar has a stable list', () => {
    const nodes = [root(), pane('second', null, 1), pane('first', null, 0)];
    expect(detachedOf(nodes).map((n) => n.id)).toEqual(['first', 'second']);
  });
});

describe('descendantsOf', () => {
  it('should return the whole subtree, not just the direct children', () => {
    const nodes = [
      root(),
      split('col', 'root-1', 0),
      pane('top', 'col', 0),
      pane('bottom', 'col', 1),
      pane('elsewhere', 'root-1', 1),
    ];
    expect(descendantsOf(nodes, 'col').map((n) => n.id).sort()).toEqual(['bottom', 'top']);
  });

  it('should return nothing for a leaf', () => {
    const nodes = [root(), pane('only', 'root-1', 0)];
    expect(descendantsOf(nodes, 'only')).toEqual([]);
  });

  it('should terminate on a cyclic list rather than hanging', () => {
    // A flat parent pointer can express what a nested type cannot. Traversal
    // must stay total even on input `validateTree` would reject, because this
    // helper is what the validator itself walks with.
    const cyclic: WorkspaceNode[] = [
      { nodeType: 'split', id: 'a', parentId: 'b', position: 0, axis: 'row' },
      { nodeType: 'split', id: 'b', parentId: 'a', position: 0, axis: 'row' },
    ];
    expect(descendantsOf(cyclic, 'a').map((n) => n.id)).toEqual(['b']);
  });
});

describe('findNode', () => {
  it('should find a node by id', () => {
    expect(findNode([root(), pane('a', 'root-1', 0)], 'a')?.id).toBe('a');
  });

  it('should find nothing for an unknown id, rather than throwing', () => {
    expect(findNode([root()], 'no-such-node')).toBeUndefined();
  });
});

describe('upsertNodes', () => {
  it('should replace a node by id and leave its siblings alone', () => {
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    const moved: PaneNode = { ...pane('a', 'root-1', 0), position: 5 };
    const after = upsertNodes(before, [moved]);
    expect(findNode(after, 'a')?.position).toBe(5);
    expect(findNode(after, 'b')?.position).toBe(1);
  });

  it('should append a node whose id is not already present', () => {
    const after = upsertNodes([root()], [pane('fresh', 'root-1', 0)]);
    expect(findNode(after, 'fresh')?.id).toBe('fresh');
  });

  it('should leave the input untouched', () => {
    const before = [root(), pane('a', 'root-1', 0)];
    upsertNodes(before, [{ ...pane('a', 'root-1', 0), position: 9 }]);
    expect(findNode(before, 'a')?.position).toBe(0);
  });

  it('should give the same result applied twice as applied once — a replayed write must be a no-op', () => {
    // This is the property that retires the layout-ops idempotency memory:
    // a duplicate delivery or a retried POST re-applies to the same state.
    const before = [root(), pane('a', 'root-1', 0)];
    const change = [pane('b', 'root-1', 1)];
    expect(upsertNodes(upsertNodes(before, change), change)).toEqual(upsertNodes(before, change));
  });
});

describe('removeNodes', () => {
  it('should remove exactly the named ids', () => {
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    expect(removeNodes(before, ['a']).map((n) => n.id)).toEqual(['root-1', 'b']);
  });

  it('should ignore an id that is not there, rather than throwing', () => {
    const before = [root(), pane('a', 'root-1', 0)];
    expect(removeNodes(before, ['ghost']).map((n) => n.id)).toEqual(['root-1', 'a']);
  });
});
