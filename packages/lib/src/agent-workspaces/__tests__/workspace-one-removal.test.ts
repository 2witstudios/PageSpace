/**
 * ONE REMOVAL, AND NO PARENTLESS PANES — the two corrections, tested where they
 * meet.
 *
 * The epic exists to delete a bug class: membership and layout stored as two
 * structures, reconciled by convention. The node-tree cutover rebuilt that class
 * twice, once at each end of the tree:
 *
 *  - **At the bottom**, a non-root node was allowed a null `parentId` and that
 *    was called DETACHED — a legal resting state. So a pane that lost its parent
 *    through a defect was indistinguishable from one a user closed, and
 *    `validateTree` could reject a DANGLING parent but never a NULL one.
 *  - **At the top**, the root was immutable for `destroy`, which forced ending a
 *    session to be a second lifecycle mechanism beside the tree's own removal.
 *
 * This suite pins the corrected shape: ONE removal pointed at different nodes,
 * and a parent pointer that is null on the root and nowhere else. It is
 * deliberately separate from the per-module suites — these are the assertions
 * that would have caught the two mistakes, and they read as one argument rather
 * than as scattered cases.
 */
import { describe, it, expect } from 'vitest';
import { create, destroy, move, resize, bind } from '../workspace-node-algebra';
import { closePane, replaceConversation, split } from '../workspace-node-commands';
import { validateTree } from '../workspace-node-validate';
import { nodeFromRow, type WorkspaceNodeRow } from '../workspace-node-rows';
import { findNode, rootOf, type PaneNode, type RootNode, type SplitNode, type WorkspaceNode } from '../workspace-node';
import { admit, expel } from '../workspace-membership';

function root(): RootNode {
  return { nodeType: 'root', id: 'root-1', parentId: null, position: 0, axis: 'row' };
}

function pane(id: string, parentId: string, position: number, conversation = `conv-${id}`): PaneNode {
  return { nodeType: 'pane', id, parentId, position, target: { kind: 'chat', id: conversation } };
}

function splitNode(id: string, parentId: string, position: number): SplitNode {
  return { nodeType: 'split', id, parentId, position, axis: 'column' };
}

/** Root → [pane-a, pane-b]. The smallest grid with something to remove. */
function twoPaneGrid(): WorkspaceNode[] {
  return [root(), pane('pane-a', 'root-1', 0), pane('pane-b', 'root-1', 1)];
}

function expectOk(result: { ok: boolean }): asserts result is { ok: true } & Record<string, unknown> {
  expect(result).toMatchObject({ ok: true });
}

// ---------------------------------------------------------------------------
// One removal
// ---------------------------------------------------------------------------

describe('destroy is one operation pointed at different nodes', () => {
  it('destroys a pane when pointed at a pane', () => {
    const nodes = twoPaneGrid();
    const result = destroy(nodes, { nodeId: 'pane-a' });
    expectOk(result);
    expect(result.write.drop).toEqual(['pane-a']);
  });

  it('destroys the whole session when pointed at the root', () => {
    const nodes = [root(), splitNode('s1', 'root-1', 0), pane('pane-a', 's1', 0), pane('pane-b', 's1', 1)];
    const result = destroy(nodes, { nodeId: 'root-1' });
    expectOk(result);
    // Subtree and all: every id the workspace held, and nothing left to put.
    expect([...result.write.drop].sort()).toEqual(['pane-a', 'pane-b', 'root-1', 's1']);
    expect(result.write.put).toEqual([]);
  });

  it('leaves an EMPTY node set, which is a valid tree', () => {
    const nodes = twoPaneGrid();
    const result = destroy(nodes, { nodeId: 'root-1' });
    expectOk(result);
    expect(validateTree([])).toEqual({ ok: true });
  });

  it('still refuses to MOVE the root — a workspace has no outside', () => {
    expect(move(twoPaneGrid(), { nodeId: 'root-1', parentId: 'root-1', index: 0 })).toMatchObject({
      ok: false,
      code: 'root_immutable',
    });
  });

  it('still refuses to BIND the root — it shows nothing of its own', () => {
    expect(bind(twoPaneGrid(), { nodeId: 'root-1', target: { kind: 'chat', id: 'c' } })).toMatchObject({
      ok: false,
      code: 'root_immutable',
    });
  });

  it('still refuses to RESIZE the root — it is not a share of anything', () => {
    expect(resize(twoPaneGrid(), { nodeId: 'root-1', fraction: 0.5 })).toMatchObject({
      ok: false,
      code: 'root_immutable',
    });
  });
});

// ---------------------------------------------------------------------------
// No parentless panes — the type, the validator, and the row parse
// ---------------------------------------------------------------------------

describe('a non-root node with no parent is invalid', () => {
  it('validateTree gives it its OWN code, not `unreachable`', () => {
    // Spellable only by lying to the type checker — which is exactly the point:
    // a ROW can carry this, so the validator still has to state it.
    const orphan = { nodeType: 'pane', id: 'pane-x', parentId: null, position: 0, target: null } as unknown as WorkspaceNode;
    expect(validateTree([root(), orphan])).toMatchObject({ ok: false, code: 'null_parent' });
  });

  it('is reported ahead of a dangling parent, so one bad tree names the fault it has', () => {
    const orphan = { nodeType: 'pane', id: 'pane-x', parentId: null, position: 0, target: null } as unknown as WorkspaceNode;
    const dangling = pane('pane-y', 'nowhere', 1);
    expect(validateTree([root(), orphan, dangling])).toMatchObject({ ok: false, code: 'null_parent' });
  });

  it('nodeFromRow REFUSES a non-root row whose parentId is null', () => {
    const row: WorkspaceNodeRow = {
      id: 'pane-x',
      rootId: 'root-1',
      parentId: null,
      position: 0,
      nodeType: 'pane',
      axis: null,
      fraction: null,
      targetKind: 'chat',
      targetId: 'conv-1',
    };
    expect(() => nodeFromRow(row)).toThrow();
  });

  it('nodeFromRow still accepts the ROOT row, whose null parent is a consequence of its type', () => {
    const row: WorkspaceNodeRow = {
      id: 'root-1',
      rootId: 'root-1',
      parentId: null,
      position: 0,
      nodeType: 'root',
      axis: 'row',
      fraction: null,
      targetKind: null,
      targetId: null,
    };
    expect(nodeFromRow(row)).toEqual(root());
  });
});

// ---------------------------------------------------------------------------
// Closing is a destroy, not a move to nowhere
// ---------------------------------------------------------------------------

describe('closePane destroys', () => {
  it('removes the pane rather than parking it', () => {
    const result = closePane(twoPaneGrid(), { nodeId: 'pane-a' });
    expectOk(result);
    expect(result.write.drop).toEqual(['pane-a']);
    expect(result.write.put.some((node) => node.id === 'pane-a')).toBe(false);
  });

  it('closing the LAST pane leaves the session standing with an empty tree', () => {
    const nodes: WorkspaceNode[] = [root(), pane('pane-a', 'root-1', 0)];
    const result = closePane(nodes, { nodeId: 'pane-a' });
    expectOk(result);
    const next = nodes.filter((node) => !result.write.drop.includes(node.id));
    expect(rootOf(next)).toBeDefined();
    expect(validateTree(next)).toEqual({ ok: true });
  });

  it('replaceConversation destroys the pane it displaces', () => {
    const nodes: WorkspaceNode[] = [
      root(),
      pane('pane-a', 'root-1', 0, 'conv-a'),
      pane('pane-b', 'root-1', 1, 'conv-b'),
    ];
    const result = replaceConversation(nodes, { nodeId: 'pane-a', target: { kind: 'chat', id: 'conv-b' } });
    expectOk(result);
    expect(result.write.drop).toContain('pane-a');
  });
});

// ---------------------------------------------------------------------------
// Nothing mints or moves a node to nowhere any more
// ---------------------------------------------------------------------------

describe('there is nowhere for a node to be but the tree', () => {
  it('create always lands under the parent it names', () => {
    const result = create(twoPaneGrid(), { nodeId: 'pane-c', target: null, parentId: 'root-1' });
    expectOk(result);
    const minted = result.write.put.find((node) => node.id === 'pane-c');
    expect(minted?.parentId).toBe('root-1');
  });

  it('a split may be destroyed but never parked — every child keeps a parent', () => {
    const nodes = [root(), splitNode('s1', 'root-1', 0), pane('pane-a', 's1', 0), pane('pane-b', 's1', 1)];
    const result = destroy(nodes, { nodeId: 's1' });
    expectOk(result);
    const next = nodes
      .filter((node) => !result.write.drop.includes(node.id))
      .map((node) => result.write.put.find((changed) => changed.id === node.id) ?? node);
    for (const node of next) {
      if (node.nodeType !== 'root') expect(node.parentId).not.toBeNull();
    }
  });

  it('split refuses nothing about placement any more — every pane has a container', () => {
    const nodes = twoPaneGrid();
    const result = split(nodes, { nodeId: 'pane-a', axis: 'row', newNodeId: 'pane-new', newSplitId: 'split-new' });
    expectOk(result);
  });
});

// ---------------------------------------------------------------------------
// Membership: every member is in the tree
// ---------------------------------------------------------------------------

describe('membership has no unplaced state', () => {
  it('admit places the newcomer in the grid', () => {
    const nodes = twoPaneGrid();
    const result = admit(nodes, {
      target: { kind: 'chat', id: 'conv-new' },
      newNodeId: 'pane-new',
      newSplitId: 'split-new',
    });
    expectOk(result);
    const minted = result.write.put.find(
      (node) => node.nodeType === 'pane' && node.target?.id === 'conv-new',
    );
    expect(minted).toBeDefined();
    expect(minted?.parentId).not.toBeNull();
  });

  it('admit into an EMPTY workspace REFUSES rather than minting a root of its own', () => {
    // The inverse of what this pinned before, and the inversion is the fix.
    // `admit` used to take a caller-chosen `newRootId` and mint the tree here;
    // both production callers chose `createId()`, so two first admissions
    // racing each other proposed two DIFFERENT roots and the single-root index
    // picked a loser. Seeding moved to `seedRoot`, which derives the id from
    // the workspace inside the same locked transaction, so racing seeds now
    // produce an identical write and converge on the upsert.
    //
    // `admit` cannot do that derivation without being handed a workspaceId, and
    // the pure model deliberately has no such thing — a node list with nothing
    // to point across with is what makes a cross-workspace parent unspellable.
    // So it refuses, and `commitUnderLock` makes sure it is never asked.
    const result = admit([], {
      target: { kind: 'chat', id: 'conv-new' },
      newNodeId: 'pane-new',
      newSplitId: 'split-new',
    });
    expect(result).toMatchObject({ ok: false, code: 'no_root' });
  });

  it('expel removes the member entirely — there is no parked half-membership', () => {
    const nodes = twoPaneGrid();
    const result = expel(nodes, { target: { kind: 'chat', id: 'conv-pane-a' } });
    expectOk(result);
    expect(result.write.drop).toContain('pane-a');
  });

  it('expel takes the LAST conversation without a survivor guard', () => {
    const nodes: WorkspaceNode[] = [root(), pane('pane-a', 'root-1', 0, 'conv-only')];
    const result = expel(nodes, { target: { kind: 'chat', id: 'conv-only' } });
    expectOk(result);
    expect(result.write.drop).toContain('pane-a');
  });
});

// ---------------------------------------------------------------------------
// The property the whole correction buys
// ---------------------------------------------------------------------------

describe('the invariant, stated once', () => {
  it('no accepted operation ever produces a non-root node with a null parent', () => {
    const nodes = [root(), splitNode('s1', 'root-1', 0), pane('a', 's1', 0), pane('b', 's1', 1), pane('c', 'root-1', 1)];
    const operations = [
      () => destroy(nodes, { nodeId: 'a' }),
      () => destroy(nodes, { nodeId: 's1' }),
      () => move(nodes, { nodeId: 'a', parentId: 'root-1', index: 0 }),
      () => create(nodes, { nodeId: 'd', target: null, parentId: 'root-1' }),
      () => closePane(nodes, { nodeId: 'c' }),
    ];
    for (const run of operations) {
      const result = run();
      expectOk(result);
      for (const node of result.write.put) {
        if (node.nodeType !== 'root') expect(node.parentId).not.toBeNull();
      }
    }
  });

  it('findNode/rootOf still identify the root by TYPE, which is now the only null parent', () => {
    const nodes = twoPaneGrid();
    expect(rootOf(nodes)?.id).toBe('root-1');
    expect(findNode(nodes, 'root-1')?.parentId).toBeNull();
  });
});
