/**
 * What closing a pane MEANS. Two branches where there were five — the model
 * removed three of them, and each removal is pinned here by its absence being
 * asserted rather than merely no longer written.
 */
import { describe, it, expect } from 'vitest';
import type { PaneNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import { decideClosePane, type SessionConversationSummary } from '../close-pane';

const WS = 'ws-1';

function chat(id: string, conversationId: string, parentId: string = WS): PaneNode {
  return { nodeType: 'pane', id, parentId, position: 0, target: { kind: 'chat', id: conversationId } };
}
function terminal(id: string, shellId: string): PaneNode {
  return { nodeType: 'pane', id, parentId: WS, position: 0, target: { kind: 'terminal', id: shellId } };
}
function picker(id: string): PaneNode {
  return { nodeType: 'pane', id, parentId: WS, position: 0, target: null };
}

const listing = (...ids: string[]): SessionConversationSummary[] =>
  ids.map((conversationId) => ({ conversationId, agentPageId: null, lastMessageAt: null }));

describe('decideClosePane', () => {
  it('should do nothing for a node the workspace does not hold', () => {
    expect(decideClosePane({ panes: [chat('n1', 'c1')], nodeId: 'ghost', activeConversations: listing('c1') })).toEqual({
      action: 'noop',
    });
  });

  it('should be a pure layout close for a picker pane', () => {
    expect(decideClosePane({ panes: [picker('n1')], nodeId: 'n1', activeConversations: listing() })).toEqual({
      action: 'close-pane',
    });
  });

  it('should be a pure layout close for a terminal pane', () => {
    expect(
      decideClosePane({ panes: [terminal('n1', 'shell-1')], nodeId: 'n1', activeConversations: listing() }),
    ).toEqual({ action: 'close-pane' });
  });

  it('should close the THREAD for a chat pane whose listing is open', () => {
    expect(decideClosePane({ panes: [chat('n1', 'c1')], nodeId: 'n1', activeConversations: listing('c1') })).toEqual({
      action: 'close-conversation',
      conversationId: 'c1',
    });
  });

  /**
   * "Not yet loaded" is not "loaded and empty". Treating it as the latter would
   * silently make this a pure layout close while the thread's listing stays open
   * server-side, lingering in the sidebar and holding a cap slot with no pane
   * left to retry the close from.
   */
  it('should do nothing while the listing has not resolved', () => {
    expect(decideClosePane({ panes: [chat('n1', 'c1')], nodeId: 'n1', activeConversations: null })).toEqual({
      action: 'noop',
    });
  });

  it('should be a pure layout close when the listing resolved WITHOUT this thread', () => {
    // Somebody else already closed it: there is nothing left to DELETE.
    expect(decideClosePane({ panes: [chat('n1', 'c1')], nodeId: 'n1', activeConversations: listing('c2') })).toEqual({
      action: 'close-pane',
    });
  });

  /**
   * THE THREE BRANCHES THE MODEL RETIRED. Each is asserted as a NON-outcome,
   * because "we stopped writing that code" and "that outcome can no longer
   * happen" are different claims and only the second one is a guarantee.
   */
  describe('what the model retired', () => {
    it('should NOT offer to end the workspace when the last pane closes', () => {
      // An empty grid is a resting state. Ending is a lifecycle act elsewhere.
      const decision = decideClosePane({
        panes: [chat('only', 'c1')],
        nodeId: 'only',
        activeConversations: listing('c1'),
      });
      expect(decision.action).toBe('close-conversation');
      expect(decision).not.toHaveProperty('rebindTo');
    });

    it('should NOT offer to end the workspace when the last pane is a picker either', () => {
      expect(decideClosePane({ panes: [picker('only')], nodeId: 'only', activeConversations: listing() })).toEqual({
        action: 'close-pane',
      });
    });

    it('should NOT rebind the last pane to some other open thread', () => {
      const decision = decideClosePane({
        panes: [picker('only')],
        nodeId: 'only',
        activeConversations: listing('c-other'),
      });
      expect(decision).toEqual({ action: 'close-pane' });
    });

    it('should close the thread for a node nested below a split, like any other', () => {
      // Was stated with a PARKED node. Where a pane sits was never part of this
      // decision — what it reads is the LISTING — and depth is what "somewhere
      // other than the root's own children" means now.
      expect(
        decideClosePane({ panes: [chat('n1', 'c1', 's1')], nodeId: 'n1', activeConversations: listing('c1') }),
      ).toEqual({ action: 'close-conversation', conversationId: 'c1' });
    });
  });
});
