/**
 * `applyNodeWrite` UNDER THE TABLE'S DELETE SEMANTICS.
 *
 * The order the two halves of a `NodeWrite` are applied in is unobservable in
 * memory — `removeNodes` removes exactly the ids it is named, so put-then-drop
 * and drop-then-put agree on every disjoint write. It is NOT unobservable in
 * the database. `agent_workspace_nodes` carries a composite self-FK
 * `(rootId, parentId) → (rootId, id)` that is `ON DELETE cascade`, so deleting
 * a container takes its whole subtree with it — which the schema documents as
 * a feature, and which the collapse path in `move`/`destroy` walks straight
 * into: it drops a split whose children are being REPARENTED, not deleted, and
 * those children appear only in `put`.
 *
 * So this suite substitutes the storage's `removeNodes` for the model's, and
 * runs the real `applyNodeWrite` against it. That is the one thing the memory
 * helper deliberately does not do and the one thing the ordering exists to
 * survive; a suite that stubbed anything else here would be testing its own
 * re-implementation instead.
 *
 * The shapes are NESTED on purpose. A flat tree passes whichever order is
 * used, because nothing is beneath the node being dropped — which is exactly
 * why the defect this pins survived a suite of 519 tests.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PaneNode, RootNode, SplitNode, WorkspaceNode } from '../workspace-node';

/**
 * `DELETE FROM agent_workspace_nodes WHERE id IN (...)` with the self-FK's
 * cascade, in place of `removeNodes`. Transitive, because the cascade is: the
 * rows deleted for naming a deleted parent are themselves parents.
 *
 * Hoisted above the imports by vitest, so it may close over nothing from this
 * file but types, which erase.
 */
vi.mock('../workspace-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace-node')>();
  const removeNodes = (
    nodes: readonly WorkspaceNode[],
    ids: readonly string[],
  ): WorkspaceNode[] => {
    const dropping = new Set(ids);
    for (let grew = true; grew; ) {
      grew = false;
      for (const node of nodes) {
        if (node.parentId === null || dropping.has(node.id)) continue;
        if (dropping.has(node.parentId)) {
          dropping.add(node.id);
          grew = true;
        }
      }
    }
    return nodes.filter((node) => !dropping.has(node.id));
  };
  return { ...actual, removeNodes };
});

import { applyNodeWrite, destroy, move, type NodeOperationResult } from '../workspace-node-algebra';

function root(): RootNode {
  return { nodeType: 'root', id: 'root-1', parentId: null, position: 0, axis: 'row' };
}

function split(id: string, parentId: string, position: number): SplitNode {
  return { nodeType: 'split', id, parentId, position, axis: 'column' };
}

function pane(id: string, parentId: string, position: number): PaneNode {
  return { nodeType: 'pane', id, parentId, position, target: { kind: 'chat', id: `conv-${id}` } };
}

/** The accepted write, or a failure naming the code that came back instead. */
function accepted(result: NodeOperationResult): { put: WorkspaceNode[]; drop: string[] } {
  if (!result.ok) throw new Error(`expected an accepted operation, got ${result.code}: ${result.detail}`);
  return result.write;
}

/**
 * `root → s1 → { s2 → { a, b }, c }`, with `d` beside `s1`.
 *
 * The point of the shape: taking `c` out of `s1` leaves `s1` holding one child,
 * so `s1` collapses and `s2` is PROMOTED into its place. `a` and `b` are
 * untouched by that and are therefore correctly absent from `put` — they sit
 * below the promoted node, not beside it.
 */
function nested(): WorkspaceNode[] {
  return [
    root(),
    split('s1', 'root-1', 0),
    pane('d', 'root-1', 1),
    split('s2', 's1', 0),
    pane('c', 's1', 1),
    pane('a', 's2', 0),
    pane('b', 's2', 1),
  ];
}

function idsOf(nodes: readonly WorkspaceNode[]): string[] {
  return nodes.map((node) => node.id).sort();
}

describe('applyNodeWrite against a cascading store', () => {
  it('should land a promoted subtree before the collapsed container is dropped, on a move', () => {
    // Dropping `s1` first cascades `s2` away, and `a` and `b` with it — panes
    // and their conversation bindings destroyed by a drag-to-reorder. `put`
    // cannot resurrect them, because it never named them. Worse, the wreckage
    // is also invalid: `s2` comes back holding no children at all.
    const before = nested();
    const after = applyNodeWrite(before, accepted(move(before, { nodeId: 'c', parentId: 'root-1', index: 1 })));
    expect(idsOf(after)).toEqual(['a', 'b', 'c', 'd', 'root-1', 's2']);
  });

  it('should land a promoted subtree before the collapsed container is dropped, on a destroy', () => {
    // `destroy` collapses through exactly the path `move` does, so it names the
    // same container in `drop` and the same promoted node in `put`.
    const before = nested();
    const after = applyNodeWrite(before, accepted(destroy(before, { nodeId: 'c' })));
    expect(idsOf(after)).toEqual(['a', 'b', 'd', 'root-1', 's2']);
  });

  it('should still remove a destroyed subtree, which the write names in full', () => {
    // The order is not "never delete anything": `destroy` names its whole
    // subtree in `drop`, so applying `put` first leaves nothing that keeps
    // those rows alive. This is the case a cascade is genuinely for.
    const before = nested();
    const after = applyNodeWrite(before, accepted(destroy(before, { nodeId: 's2' })));
    expect(idsOf(after)).toEqual(['c', 'd', 'root-1']);
  });
});
