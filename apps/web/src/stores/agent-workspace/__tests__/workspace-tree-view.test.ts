/**
 * The derivations both renderings share — and, above all, the cases that only
 * exist because a member can be in the workspace WITHOUT being on the screen.
 */
import { describe, expect, it } from 'vitest';
import type { PaneNode, WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import type { WorkspaceTree } from '../useAgentWorkspaceStore';
import {
  artifactRowsOf,
  conversationPlacement,
  gridPanesOf,
  indexTargets,
  isOnGrid,
  lookupTarget,
  nodeShowing,
  paneNodesOf,
  titleOf,
} from '../workspace-tree-view';

const WS = 'ws-1';
const root: WorkspaceNode = { nodeType: 'root', id: WS, parentId: null, position: 0, axis: 'row' };

function chat(id: string, parentId: string | null, position: number, conversationId: string): PaneNode {
  return { nodeType: 'pane', id, parentId, position, target: { kind: 'chat', id: conversationId } };
}
function page(id: string, parentId: string | null, position: number, pageId: string): PaneNode {
  return { nodeType: 'pane', id, parentId, position, target: { kind: 'page', id: pageId } };
}
function shell(id: string, parentId: string | null, position: number, shellId: string): PaneNode {
  return { nodeType: 'pane', id, parentId, position, target: { kind: 'terminal', id: shellId } };
}

function makeTree(nodes: WorkspaceNode[], targets: WorkspaceTree['targets'] = []): WorkspaceTree {
  return { workspaceId: WS, rev: 1, nodes, targets, activeNodeId: null, pendingPickerNodeId: null };
}

describe('gridPanesOf', () => {
  it('should walk depth-first through nested containers, in render order', () => {
    const nodes: WorkspaceNode[] = [
      root,
      { nodeType: 'split', id: 's', parentId: WS, position: 0, axis: 'column' },
      chat('a', 's', 0, 'c1'),
      chat('b', 's', 1, 'c2'),
      chat('c', WS, 1, 'c3'),
    ];
    expect(gridPanesOf(nodes).map((node) => node.id)).toEqual(['a', 'b', 'c']);
  });

  it('should exclude PARKED panes — they are members, not rectangles', () => {
    const nodes = [root, chat('a', WS, 0, 'c1'), chat('parked', null, 0, 'c2')];
    expect(gridPanesOf(nodes).map((node) => node.id)).toEqual(['a']);
    expect(paneNodesOf(nodes).map((node) => node.id)).toEqual(['a', 'parked']);
  });

  it('should answer nothing for a tree with no root', () => {
    expect(gridPanesOf([])).toEqual([]);
  });

  it('should terminate on a cyclic parent chain', () => {
    const nodes: WorkspaceNode[] = [
      root,
      { nodeType: 'split', id: 's1', parentId: WS, position: 0, axis: 'row' },
      { nodeType: 'split', id: 's2', parentId: 's1', position: 0, axis: 'row' },
      // s1 re-parented under its own descendant — a cycle the wire could carry.
      { nodeType: 'split', id: 's3', parentId: 's2', position: 0, axis: 'row' },
      chat('a', 's3', 0, 'c1'),
    ];
    expect(() => gridPanesOf([...nodes, { ...nodes[1], parentId: 's3' } as WorkspaceNode])).not.toThrow();
  });
});

describe('titleOf', () => {
  const index = indexTargets([
    { id: 'c1', kind: 'chat', title: 'Planning', lastMessageAt: null, agentPageId: 'agent-1' },
  ]);

  it('should use the resolved title', () => {
    expect(titleOf(index, chat('a', WS, 0, 'c1'))).toBe('Planning');
  });

  /**
   * A target with no entry is either GONE or one this viewer may not read, and
   * the two are deliberately indistinguishable. Either way the node still
   * occupies a rectangle and still has to be closable, so it must never render
   * as an error or collapse to nothing.
   */
  it('should fall back to the kind for an unresolved target', () => {
    expect(titleOf(index, chat('a', WS, 0, 'unknown'))).toBe('Conversation');
    expect(titleOf(index, page('b', WS, 1, 'unknown'))).toBe('Page');
    expect(titleOf(index, shell('c', WS, 2, 'unknown'))).toBe('Shell');
  });

  it('should fall back for a resolved-but-blank title, which redaction can produce', () => {
    const blank = indexTargets([{ id: 'c9', kind: 'chat', title: '   ', lastMessageAt: null, agentPageId: null }]);
    expect(titleOf(blank, chat('a', WS, 0, 'c9'))).toBe('Conversation');
  });

  it('should name an unbound pane', () => {
    expect(titleOf(index, { nodeType: 'pane', id: 'a', parentId: WS, position: 0, target: null })).toBe('New pane');
  });

  it('should not resolve a target of the wrong KIND with the same id', () => {
    // `targetId` is polymorphic — a conversation id and a page id may coincide.
    expect(lookupTarget(index, page('a', WS, 0, 'c1'))).toBeUndefined();
  });
});

describe('artifactRowsOf', () => {
  it('should list a page pane that is PARKED as well as one on the grid', () => {
    const tree = makeTree(
      [root, page('open', WS, 0, 'page-a'), page('closed', null, 0, 'page-b')],
      [
        { id: 'page-a', kind: 'page', title: 'Spec', lastMessageAt: null, agentPageId: null },
        { id: 'page-b', kind: 'page', title: 'Notes', lastMessageAt: null, agentPageId: null },
      ],
    );
    expect(artifactRowsOf(tree)).toEqual([
      { key: 'page:page-a', kind: 'page', targetId: 'page-a', title: 'Spec', placement: 'grid', nodeId: 'open' },
      { key: 'page:page-b', kind: 'page', targetId: 'page-b', title: 'Notes', placement: 'parked', nodeId: 'closed' },
    ]);
  });

  it('should not list chats — the conversation listing owns those rows', () => {
    const tree = makeTree([root, chat('a', WS, 0, 'c1')]);
    expect(artifactRowsOf(tree)).toEqual([]);
  });

  it('should not list terminals — the shell list already covers every shell', () => {
    const tree = makeTree([root, shell('a', WS, 0, 'shell-1')]);
    expect(artifactRowsOf(tree)).toEqual([]);
  });

  it('should list one row for a page open in two panes, addressed by the grid-first node', () => {
    const tree = makeTree(
      [root, page('first', WS, 0, 'page-a'), page('second', WS, 1, 'page-a')],
      [{ id: 'page-a', kind: 'page', title: 'Spec', lastMessageAt: null, agentPageId: null }],
    );
    const rows = artifactRowsOf(tree);
    expect(rows).toHaveLength(1);
    expect(rows[0].nodeId).toBe('first');
  });
});

describe('conversationPlacement', () => {
  const tree = makeTree([root, chat('open', WS, 0, 'c1'), chat('closed', null, 0, 'c2')]);

  it('should report a thread on the grid', () => {
    expect(conversationPlacement(tree, 'c1')).toEqual({ placement: 'grid', nodeId: 'open' });
  });

  it('should report a PARKED thread, which is the state the sidebar must not hide', () => {
    expect(conversationPlacement(tree, 'c2')).toEqual({ placement: 'parked', nodeId: 'closed' });
  });

  /** #2373: a thread created without placement has no node at all, and is still a member. */
  it('should report a thread with no node as unplaced', () => {
    expect(conversationPlacement(tree, 'never-placed')).toEqual({ placement: 'unplaced', nodeId: null });
  });

  it('should report unplaced for a workspace the store has not seated', () => {
    expect(conversationPlacement(undefined, 'c1')).toEqual({ placement: 'unplaced', nodeId: null });
  });
});

describe('nodeShowing / isOnGrid', () => {
  const nodes = [root, chat('open', WS, 0, 'c1'), chat('closed', null, 0, 'c2')];

  it('should find a PARKED node, because it still holds the binding', () => {
    expect(nodeShowing(nodes, 'chat', 'c2')?.id).toBe('closed');
  });

  it('should distinguish on-grid from parked', () => {
    expect(isOnGrid(nodes, 'open')).toBe(true);
    expect(isOnGrid(nodes, 'closed')).toBe(false);
    expect(isOnGrid(nodes, 'ghost')).toBe(false);
  });
});
