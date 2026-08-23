import { describe, expect, it } from 'vitest';
import type { NodeWrite } from '@pagespace/lib/agent-workspaces/workspace-node-algebra';
import { closePane, split } from '@pagespace/lib/agent-workspaces/workspace-node-commands';
import { create, resize } from '@pagespace/lib/agent-workspaces/workspace-node-algebra';
import type { WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import {
  emptyWrite,
  isAdoptableTree,
  isEmptyWrite,
  makePending,
  rebasePending,
  unionWrites,
} from '../node-writes';

const root: WorkspaceNode = { nodeType: 'root', id: 'R', parentId: null, position: 0, axis: 'row' };

function pane(id: string, parentId: string, position: number, targetId?: string): WorkspaceNode {
  return {
    nodeType: 'pane',
    id,
    parentId,
    position,
    target: targetId === undefined ? null : { kind: 'chat', id: targetId },
  };
}

/** Two panes under the root — the shape almost every case below starts from. */
const twoPanes: WorkspaceNode[] = [root, pane('a', 'R', 0, 'c1'), pane('b', 'R', 1, 'c2')];

function writeOf(result: { ok: boolean } & Record<string, unknown>): NodeWrite {
  if (!result.ok) throw new Error(`expected an accepted operation, got ${JSON.stringify(result)}`);
  return result.write as NodeWrite;
}

describe('emptyWrite / isEmptyWrite', () => {
  it('should treat a write with no put and no drop as empty', () => {
    expect(isEmptyWrite(emptyWrite())).toBe(true);
  });

  it('should not treat a drop-only write as empty, because a drop is a change', () => {
    expect(isEmptyWrite({ put: [], drop: ['a'] })).toBe(false);
  });
});

describe('makePending', () => {
  it('should record as MINTED only the ids absent from the tree the write was computed against', () => {
    const write = writeOf(split(twoPanes, { nodeId: 'a', axis: 'row', newNodeId: 'n', newSplitId: 's' }));
    const entry = makePending('w1', twoPanes, write);
    // `split` puts the container, the moved pane and the new pane; only the
    // container and the new pane are new.
    expect([...entry.minted].sort()).toEqual(['n', 's']);
  });

  it('should mint nothing for a write that only edits nodes already present', () => {
    const write = writeOf(resize(twoPanes, { nodeId: 'a', fraction: 0.3 }));
    expect(makePending('w1', twoPanes, write).minted).toEqual([]);
  });
});

describe('unionWrites', () => {
  it('should let a later put supersede an earlier put of the same id', () => {
    const first: NodeWrite = { put: [pane('a', 'R', 0)], drop: [] };
    const second: NodeWrite = { put: [pane('a', 'R', 5)], drop: [] };
    const union = unionWrites([first, second]);
    expect(union.put).toHaveLength(1);
    expect(union.put[0].position).toBe(5);
  });

  it('should let a later drop supersede an earlier put of the same id', () => {
    const union = unionWrites([{ put: [pane('a', 'R', 0)], drop: [] }, { put: [], drop: ['a'] }]);
    expect(union.put).toEqual([]);
    expect(union.drop).toEqual(['a']);
  });

  it('should let a later put supersede an earlier drop of the same id', () => {
    const union = unionWrites([{ put: [], drop: ['a'] }, { put: [pane('a', 'R', 0)], drop: [] }]);
    expect(union.drop).toEqual([]);
    expect(union.put.map((node) => node.id)).toEqual(['a']);
  });

  it('should keep a drop of an id nothing here ever put — the wire reads it as a no-op', () => {
    expect(unionWrites([{ put: [], drop: ['ghost'] }]).drop).toEqual(['ghost']);
  });
});

describe('rebasePending — the base is unchanged', () => {
  it('should apply every write in order', () => {
    const closed = writeOf(closePane(twoPanes, { nodeId: 'a' }));
    const result = rebasePending(twoPanes, [makePending('w1', twoPanes, closed)]);
    expect(result.dropped).toEqual([]);
    // Closing DESTROYS the pane. It used to park it — same node, null parent —
    // which is the state that made a closed pane and a broken one identical.
    expect(result.nodes.find((node) => node.id === 'a')).toBeUndefined();
  });

  it('should render the base itself when nothing is pending', () => {
    expect(rebasePending(twoPanes, []).nodes).toEqual(twoPanes);
  });
});

describe('rebasePending — a pending write whose target the server deleted', () => {
  /**
   * THE resurrection case. `applyNodeWrite` is put-then-drop and `put` is an
   * upsert, so a naive replay of "resize a" onto a tree without `a` appends `a`
   * back — a pane the user destroyed, returning with its binding intact.
   */
  it('should DROP the write rather than resurrect the node it edits', () => {
    const resized = writeOf(resize(twoPanes, { nodeId: 'a', fraction: 0.3 }));
    const pendingResize = makePending('w1', twoPanes, resized);

    // Somebody else destroyed `a`; the server's tree no longer holds it.
    const serverTree: WorkspaceNode[] = [root, pane('b', 'R', 0, 'c2')];
    const result = rebasePending(serverTree, [pendingResize]);

    expect(result.dropped.map((entry) => entry.id)).toEqual(['w1']);
    expect(result.nodes.find((node) => node.id === 'a')).toBeUndefined();
    expect(result.nodes).toEqual(serverTree);
  });

  it('should still apply a write that MINTED the node, since nothing is being resurrected', () => {
    const created = writeOf(create(twoPanes, { nodeId: 'fresh', target: null, parentId: 'R' }));
    const pendingCreate = makePending('w1', twoPanes, created);

    // The server tree moved on — somebody reordered the two panes — but never
    // held `fresh`, and the grid slot the create names is still there.
    const serverTree: WorkspaceNode[] = [root, pane('b', 'R', 0, 'c2'), pane('a', 'R', 1, 'c1')];
    const result = rebasePending(serverTree, [pendingCreate]);

    expect(result.dropped).toEqual([]);
    expect(result.nodes.some((node) => node.id === 'fresh')).toBe(true);
  });

  it('should drop a write that depends on an earlier dropped one, rather than apply it alone', () => {
    // w1 creates `fresh`; w2 resizes it. On a base where `fresh` can no longer
    // be created (its parent is gone), w2 must not land on its own.
    const created = writeOf(create(twoPanes, { nodeId: 'fresh', target: null, parentId: 'R' }));
    const afterCreate = [...twoPanes, { ...(created.put.find((n) => n.id === 'fresh') as WorkspaceNode) }];
    const w1 = makePending('w1', twoPanes, created);
    const w2 = makePending('w2', afterCreate, { put: [pane('fresh', 'R', 9)], drop: [] });

    // A server tree with no root at all: `create`'s parent does not resolve.
    const serverTree: WorkspaceNode[] = [];
    const result = rebasePending(serverTree, [w1, w2]);

    expect(result.dropped.map((entry) => entry.id)).toEqual(['w1', 'w2']);
    expect(result.nodes).toEqual([]);
  });
});

describe('rebasePending — a pending write that would produce an invalid tree', () => {
  it('should drop a write whose parent the server destroyed', () => {
    const nested: WorkspaceNode[] = [
      root,
      { nodeType: 'split', id: 's', parentId: 'R', position: 0, axis: 'column' },
      pane('a', 's', 0, 'c1'),
      pane('b', 's', 1, 'c2'),
    ];
    // Pending: reorder `a` inside `s`.
    const reorder: NodeWrite = { put: [pane('a', 's', 1, 'c1'), pane('b', 's', 0, 'c2')], drop: [] };
    const entry = makePending('w1', nested, reorder);

    // The server collapsed `s` away; `a` and `b` are now the root's children.
    const serverTree: WorkspaceNode[] = [root, pane('a', 'R', 0, 'c1'), pane('b', 'R', 1, 'c2')];
    const result = rebasePending(serverTree, [entry]);

    expect(result.dropped.map((entry_) => entry_.id)).toEqual(['w1']);
    expect(result.nodes).toEqual(serverTree);
  });
});

describe('isAdoptableTree', () => {
  it('should admit an empty list — a workspace that has never been written', () => {
    expect(isAdoptableTree([])).toBe(true);
  });

  it('should admit a root holding nothing — an empty grid is a resting state', () => {
    expect(isAdoptableTree([root])).toBe(true);
  });

  it('should admit a nested tree', () => {
    const nested: WorkspaceNode[] = [
      root,
      { nodeType: 'split', id: 's1', parentId: 'R', position: 0, axis: 'column' },
      pane('a', 's1', 0, 'c1'),
      pane('b', 's1', 1, 'c2'),
    ];
    expect(isAdoptableTree(nested)).toBe(true);
  });

  it('should REFUSE a tree holding a pane with no parent — the shape a bad row would produce', () => {
    // Adoptable used to include this: a parked pane was a legal member. It is
    // `null_parent` now, so a payload carrying one is a payload this client must
    // not seat as truth.
    const parentless = { nodeType: 'pane', id: 'lost', parentId: null, position: 0, target: null } as unknown as WorkspaceNode;
    expect(isAdoptableTree([root, pane('a', 'R', 0, 'c1'), parentless])).toBe(false);
  });

  it('should refuse a tree with two roots', () => {
    const second: WorkspaceNode = { nodeType: 'root', id: 'R2', parentId: null, position: 0, axis: 'row' };
    expect(isAdoptableTree([root, second])).toBe(false);
  });

  it('should refuse a tree whose parent pointers loop', () => {
    const cyclic: WorkspaceNode[] = [
      root,
      { nodeType: 'split', id: 's1', parentId: 's2', position: 0, axis: 'row' },
      { nodeType: 'split', id: 's2', parentId: 's1', position: 0, axis: 'row' },
    ];
    expect(isAdoptableTree(cyclic)).toBe(false);
  });

  it('should refuse a tree with no root but some nodes — the shape a partial read would produce', () => {
    expect(isAdoptableTree([pane('a', 'gone', 0, 'c1')])).toBe(false);
  });
});
