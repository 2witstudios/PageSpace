/**
 * What closing a pane MEANS.
 *
 * Three branches. Two of them — the layout close and the thread close — turn on
 * what the pane HOLDS; the third turns on how many panes are left, and it is
 * decided first.
 *
 * Nearly every fixture below used to be a SINGLE-pane workspace, because the
 * pane count was not part of the decision. It is now, so each of them gained a
 * second pane and exercises the branch it was written for again. The ones that
 * were about the last pane specifically are the `end-session` pins, inverted
 * from the "we no longer do that" assertions they were.
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
/**
 * A second pane, so a fixture exercises the branch it was written for rather
 * than the last-pane branch above it. Deliberately a chat with its own thread —
 * a kind the decision has to look past, not a picker it would skip anyway.
 */
const OTHER = chat('n-other', 'c-other');

const listing = (...ids: string[]): SessionConversationSummary[] =>
  ids.map((conversationId) => ({ conversationId, agentPageId: null, lastMessageAt: null }));

/** Every case below is a member who MAY end the workspace unless it says otherwise. */
const decide = (params: Omit<Parameters<typeof decideClosePane>[0], 'canEndSession'> & { canEndSession?: boolean }) =>
  decideClosePane({ canEndSession: true, ...params });

describe('decideClosePane', () => {
  it('should do nothing for a node the workspace does not hold', () => {
    expect(decide({ panes: [chat('n1', 'c1'), OTHER], nodeId: 'ghost', activeConversations: listing('c1') })).toEqual({
      action: 'noop',
    });
  });

  it('should be a pure layout close for a picker pane', () => {
    expect(decide({ panes: [picker('n1'), OTHER], nodeId: 'n1', activeConversations: listing() })).toEqual({
      action: 'close-pane',
    });
  });

  it('should be a pure layout close for a terminal pane', () => {
    expect(
      decide({ panes: [terminal('n1', 'shell-1'), OTHER], nodeId: 'n1', activeConversations: listing() }),
    ).toEqual({ action: 'close-pane' });
  });

  it('should close the THREAD for a chat pane whose listing is open', () => {
    expect(decide({ panes: [chat('n1', 'c1'), OTHER], nodeId: 'n1', activeConversations: listing('c1') })).toEqual({
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
    expect(decide({ panes: [chat('n1', 'c1'), OTHER], nodeId: 'n1', activeConversations: null })).toEqual({
      action: 'noop',
    });
  });

  it('should be a pure layout close when the listing resolved WITHOUT this thread', () => {
    // Somebody else already closed it: there is no listing left to follow.
    expect(decide({ panes: [chat('n1', 'c1'), OTHER], nodeId: 'n1', activeConversations: listing('c2') })).toEqual({
      action: 'close-pane',
    });
  });

  it('should close the thread for a node nested below a split, like any other', () => {
    // Where a pane SITS was never part of this decision — what it reads is the
    // listing — and depth is what "somewhere other than the root's own
    // children" means now.
    expect(
      decide({ panes: [chat('n1', 'c1', 's1'), OTHER], nodeId: 'n1', activeConversations: listing('c1') }),
    ).toEqual({ action: 'close-conversation', conversationId: 'c1' });
  });

  /**
   * THE LAST PANE. These three used to assert the opposite — that the decision
   * would NOT offer to end the workspace — which was the node-tree cutover's
   * behaviour and the one the product asked to have back. Inverted deliberately:
   * closing the last pane would leave a session holding nothing, and a user
   * stranded in an empty grid with no visible way forward is what shipped.
   */
  describe('the last pane', () => {
    it('should offer to end the workspace when the last CHAT pane closes', () => {
      const decision = decide({
        panes: [chat('only', 'c1')],
        nodeId: 'only',
        activeConversations: listing('c1'),
      });
      expect(decision).toEqual({ action: 'end-session' });
    });

    it('should offer to end the workspace when the last pane is a PICKER', () => {
      // `panes` is every pane of every kind, so "last pane of any kind" needs
      // no per-kind branch — decided above the target-kind test for exactly
      // this reason.
      expect(decide({ panes: [picker('only')], nodeId: 'only', activeConversations: listing() })).toEqual({
        action: 'end-session',
      });
    });

    it('should offer to end the workspace when the last pane is a TERMINAL', () => {
      expect(decide({ panes: [terminal('only', 'shell-1')], nodeId: 'only', activeConversations: listing() })).toEqual(
        { action: 'end-session' },
      );
    });

    it('should offer to end the workspace even while the listing has NOT resolved', () => {
      // Decided ABOVE the `activeConversations === null` guard. Ending destroys
      // the tree and the sandbox and never consults the listing, so behind that
      // guard this would silently no-op while the listing loaded — which reads
      // to the user as the click being ignored.
      expect(decide({ panes: [chat('only', 'c1')], nodeId: 'only', activeConversations: null })).toEqual({
        action: 'end-session',
      });
    });

    it('should still NOT rebind the last pane to some other open thread', () => {
      // The retired branch stays retired: ending is what the user asked for and
      // is confirmed first, where a rebind was a guess nobody asked for.
      const decision = decide({
        panes: [picker('only')],
        nodeId: 'only',
        activeConversations: listing('c-other'),
      });
      expect(decision).toEqual({ action: 'end-session' });
      expect(decision).not.toHaveProperty('rebindTo');
    });

    it('should do nothing for a node the workspace does not hold, even as its only pane', () => {
      // The lookup still comes first: a stale close for a node that is gone is
      // not a reason to offer to end the workspace.
      expect(decide({ panes: [chat('only', 'c1')], nodeId: 'ghost', activeConversations: listing('c1') })).toEqual({
        action: 'noop',
      });
    });

    it('should fall back to the ordinary close for a member who may NOT end the workspace', () => {
      // `DELETE /api/agent-workspaces/{id}` is gated by `checkSessionEndAccess`,
      // stricter than the access that let them reach the pane. Offering a
      // confirm they would obey and then be refused for is worse than leaving
      // them the previous behaviour: an empty grid someone else can end.
      expect(
        decideClosePane({
          panes: [chat('only', 'c1')],
          nodeId: 'only',
          activeConversations: listing('c1'),
          canEndSession: false,
        }),
      ).toEqual({ action: 'close-conversation', conversationId: 'c1' });
    });

    it('should fall back to a pure layout close for a picker, for that same member', () => {
      expect(
        decideClosePane({
          panes: [picker('only')],
          nodeId: 'only',
          activeConversations: listing(),
          canEndSession: false,
        }),
      ).toEqual({ action: 'close-pane' });
    });
  });
});
