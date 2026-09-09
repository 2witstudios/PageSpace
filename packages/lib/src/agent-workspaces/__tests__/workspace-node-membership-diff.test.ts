/**
 * WHAT A WRITE TOOK OUT OF A WORKSPACE.
 *
 * The one property worth stating twice: this is a set difference against the
 * FINAL tree, not a reading of the write's `drop`. A hand-off drops a target
 * from one node and puts it on another in the same write, and announcing a
 * close for that would tell every subscriber a thread had left a workspace it
 * never left. Every case below is really that one distinction from a different
 * angle.
 */
import { describe, it, expect } from 'vitest';
import type { WorkspaceNode } from '../workspace-node';
import { removedChatTargets } from '../workspace-node-membership-diff';

const WS = 'ws-1';
const root: WorkspaceNode = { nodeType: 'root', id: WS, parentId: null, position: 0, axis: 'row' };
const split = (id: string, parentId: string): WorkspaceNode => ({
  nodeType: 'split',
  id,
  parentId,
  position: 0,
  axis: 'row',
});
const chat = (id: string, conversationId: string, parentId: string = WS): WorkspaceNode => ({
  nodeType: 'pane',
  id,
  parentId,
  position: 0,
  target: { kind: 'chat', id: conversationId },
});
const terminal = (id: string, shellId: string): WorkspaceNode => ({
  nodeType: 'pane',
  id,
  parentId: WS,
  position: 0,
  target: { kind: 'terminal', id: shellId },
});
const page = (id: string, pageId: string): WorkspaceNode => ({
  nodeType: 'pane',
  id,
  parentId: WS,
  position: 0,
  target: { kind: 'page', id: pageId },
});
const picker = (id: string): WorkspaceNode => ({ nodeType: 'pane', id, parentId: WS, position: 0, target: null });

describe('removedChatTargets', () => {
  it('reports a chat pane that was destroyed', () => {
    const before = [root, chat('n1', 'c1'), chat('n2', 'c2')];
    expect(removedChatTargets(before, [root, chat('n2', 'c2')])).toEqual(['c1']);
  });

  it('reports NOTHING for a hand-off — dropped from one node, put on another', () => {
    // THE CASE THAT MAKES THIS A DIFF AND NOT A READING OF `drop`. The write's
    // `drop` names `n1`; the thread never left.
    const before = [root, chat('n1', 'c1')];
    const after = [root, chat('n2', 'c1')];
    expect(removedChatTargets(before, after)).toEqual([]);
  });

  it('reports nothing for a pure move — same node, new parent', () => {
    const before = [root, chat('n1', 'c1')];
    const after = [root, split('s1', WS), chat('n1', 'c1', 's1')];
    expect(removedChatTargets(before, after)).toEqual([]);
  });

  it('reports nothing for a resize or any other write that touches no binding', () => {
    const before = [root, chat('n1', 'c1'), chat('n2', 'c2')];
    expect(removedChatTargets(before, before)).toEqual([]);
  });

  it('reports every chat in the tree when the root is destroyed', () => {
    // An end-session. This is the producer that never announced at all under
    // the old shape, because it never went near the close route.
    const before = [root, chat('n1', 'c1'), split('s1', WS), chat('n2', 'c2', 's1')];
    expect(removedChatTargets(before, []).sort()).toEqual(['c1', 'c2']);
  });

  it('reports the thread a REBIND displaced, and not the one that replaced it', () => {
    // `unbindPane` destroys the node and seats a fresh unbound one, so the old
    // thread genuinely left; the new binding is an introduction, which is
    // `introducedPaneTargets`' half of the question.
    const before = [root, chat('n1', 'c1')];
    const after = [root, chat('n2', 'c2')];
    expect(removedChatTargets(before, after)).toEqual(['c1']);
  });

  it('ignores every non-chat target', () => {
    // A page shown in two panes is ordinary and a terminal's lifecycle is the
    // shell route's; only a chat target's presence in a tree means membership.
    const before = [root, terminal('n1', 'shell-1'), page('n2', 'page-1'), picker('n3')];
    expect(removedChatTargets(before, [root])).toEqual([]);
  });

  it('ignores a chat introduced by the write', () => {
    expect(removedChatTargets([root], [root, chat('n1', 'c1')])).toEqual([]);
  });

  it('answers nothing for an empty before-tree', () => {
    expect(removedChatTargets([], [root, chat('n1', 'c1')])).toEqual([]);
  });
});
