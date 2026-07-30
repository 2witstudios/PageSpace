/**
 * The pane grid's close decision as data — the rule worth pinning is the
 * missing level the audit follow-up restores: closing the last pane bound to
 * a conversation closes THAT listing, and only the session's LAST open
 * listing closing ends the session — never the grid's pane count alone.
 */
import { describe, it, expect } from 'vitest';
import { decideClosePane, type SessionConversationSummary } from '../close-pane';
import type { PaneState } from '@/stores/agent-workspace/pane-reducer';

const chatPane = (id: string, conversationId: string | null, agentPageId: string | null = null): PaneState => ({
  id,
  scope: { kind: 'chat', name: 'Conversation', targetId: conversationId, agentPageId },
});

const terminalPane = (id: string, shellId: string | null = 'shell-1'): PaneState => ({
  id,
  scope: { kind: 'terminal', name: 'shell', targetId: shellId, agentPageId: null },
});

const pickerPane = (id: string): PaneState => ({ id, scope: null });

const listing = (
  conversationId: string,
  agentPageId: string | null = null,
  lastMessageAt: string | null = null,
): SessionConversationSummary => ({ conversationId, agentPageId, lastMessageAt });

describe('decideClosePane', () => {
  it('given a pane id not in the grid, should no-op', () => {
    expect(
      decideClosePane({ panes: [chatPane('p1', 'conv-1')], paneId: 'missing', activeConversations: [] }),
    ).toEqual({ action: 'noop' });
  });

  describe('non-chat panes (picker, terminal, mid-mint)', () => {
    it('closes the picker pane as a pure layout act when other panes remain', () => {
      expect(
        decideClosePane({
          panes: [pickerPane('p1'), chatPane('p2', 'conv-1')],
          paneId: 'p1',
          activeConversations: [listing('conv-1')],
        }),
      ).toEqual({ action: 'close-pane' });
    });

    it('ends the session when the picker is the grid\'s only pane and nothing else is open', () => {
      expect(decideClosePane({ panes: [pickerPane('p1')], paneId: 'p1', activeConversations: [] })).toEqual({
        action: 'end-session',
      });
    });

    it('closes a terminal pane as layout-only when other panes remain', () => {
      expect(
        decideClosePane({
          panes: [terminalPane('p1'), chatPane('p2', 'conv-1')],
          paneId: 'p1',
          activeConversations: [listing('conv-1')],
        }),
      ).toEqual({ action: 'close-pane' });
    });

    it('ends the session when a terminal is the grid\'s only pane and nothing else is open', () => {
      expect(decideClosePane({ panes: [terminalPane('p1')], paneId: 'p1', activeConversations: [] })).toEqual({
        action: 'end-session',
      });
    });

    it('a chat pane still mid-mint (targetId null) is treated like a non-chat pane', () => {
      expect(
        decideClosePane({
          panes: [chatPane('p1', null), chatPane('p2', 'conv-1')],
          paneId: 'p1',
          activeConversations: [listing('conv-1')],
        }),
      ).toEqual({ action: 'close-pane' });
    });

    describe('grid-last, but the session still has an open listing with no pane here', () => {
      it('a lone terminal pane rebinds to the most recently active open conversation instead of ending the session', () => {
        expect(
          decideClosePane({
            panes: [terminalPane('p1')],
            paneId: 'p1',
            activeConversations: [
              listing('conv-old', 'agent-1', '2026-01-01T00:00:00.000Z'),
              listing('conv-new', 'agent-2', '2026-01-15T00:00:00.000Z'),
            ],
          }),
        ).toEqual({ action: 'rebind-pane', conversationId: 'conv-new', agentPageId: 'agent-2' });
      });

      it('a lone picker pane rebinds the same way', () => {
        expect(
          decideClosePane({
            panes: [pickerPane('p1')],
            paneId: 'p1',
            activeConversations: [listing('conv-1', 'agent-1')],
          }),
        ).toEqual({ action: 'rebind-pane', conversationId: 'conv-1', agentPageId: 'agent-1' });
      });

      it('a lone still-minting chat pane rebinds the same way', () => {
        expect(
          decideClosePane({
            panes: [chatPane('p1', null)],
            paneId: 'p1',
            activeConversations: [listing('conv-1', 'agent-1')],
          }),
        ).toEqual({ action: 'rebind-pane', conversationId: 'conv-1', agentPageId: 'agent-1' });
      });

      it('given an unloaded (null) listing, never guesses at ending the session — no-ops instead', () => {
        // Unlike a CONFIRMED-empty listing (which still ends the session),
        // never-resolved is unknown: offering "End session" here could
        // delete another still-open conversation's shared sandbox on a
        // guess. Nothing happens; the close can be retried once known.
        expect(decideClosePane({ panes: [terminalPane('p1')], paneId: 'p1', activeConversations: null })).toEqual({
          action: 'noop',
        });
      });
    });
  });

  describe('a duplicate view (the same conversation open in another pane)', () => {
    it('closes as layout-only — the OTHER pane keeps the listing open', () => {
      expect(
        decideClosePane({
          panes: [chatPane('p1', 'conv-1'), chatPane('p2', 'conv-1')],
          paneId: 'p1',
          activeConversations: [listing('conv-1')],
        }),
      ).toEqual({ action: 'close-pane' });
    });
  });

  describe('the listing has not loaded, or no longer lists this conversation', () => {
    it('given a null (unloaded) listing, should never act on the unverified state — not grid-last', () => {
      // Genuinely unknown (never resolved, or the fetch failed) is NOT the
      // same fact as "resolved and confirmed not open" (the next test) — a
      // layout-only close here would leave the conversation's actual listing
      // open server-side with no pane left to retry the close from (caught
      // in review). `noop`, same discipline as the grid-last case below.
      expect(
        decideClosePane({
          panes: [chatPane('p1', 'conv-1'), terminalPane('p2')],
          paneId: 'p1',
          activeConversations: null,
        }),
      ).toEqual({ action: 'noop' });
    });

    it('given a null listing AND the pane is grid-last, should no-op rather than guess at ending the session', () => {
      expect(
        decideClosePane({ panes: [chatPane('p1', 'conv-1')], paneId: 'p1', activeConversations: null }),
      ).toEqual({ action: 'noop' });
    });

    it('given the conversation absent from a loaded listing (closed elsewhere), should fall back the same way', () => {
      expect(
        decideClosePane({
          panes: [chatPane('p1', 'conv-1'), terminalPane('p2')],
          paneId: 'p1',
          activeConversations: [listing('conv-other')],
        }),
      ).toEqual({ action: 'close-pane' });
    });
  });

  describe('the last pane bound to an open-listed conversation, other listings exist', () => {
    it('given the pane is NOT grid-last, should close the conversation with no rebind', () => {
      expect(
        decideClosePane({
          panes: [chatPane('p1', 'conv-1'), terminalPane('p2')],
          paneId: 'p1',
          activeConversations: [listing('conv-1'), listing('conv-2')],
        }),
      ).toEqual({ action: 'close-conversation', conversationId: 'conv-1', rebindTo: null, rebindAgentPageId: null });
    });

    it('given the pane IS grid-last, should close the conversation and rebind to the most recently active other listing', () => {
      expect(
        decideClosePane({
          panes: [chatPane('p1', 'conv-1')],
          paneId: 'p1',
          activeConversations: [
            listing('conv-1'),
            listing('conv-old', 'agent-2', '2026-01-01T00:00:00.000Z'),
            listing('conv-new', 'agent-3', '2026-01-15T00:00:00.000Z'),
          ],
        }),
      ).toEqual({
        action: 'close-conversation',
        conversationId: 'conv-1',
        rebindTo: 'conv-new',
        rebindAgentPageId: 'agent-3',
      });
    });

    it('treats a never-messaged other listing as older than any messaged one when rebinding', () => {
      expect(
        decideClosePane({
          panes: [chatPane('p1', 'conv-1')],
          paneId: 'p1',
          activeConversations: [listing('conv-1'), listing('conv-never', 'agent-2', null), listing('conv-messaged', 'agent-3', '2026-01-01T00:00:00.000Z')],
        }),
      ).toEqual({
        action: 'close-conversation',
        conversationId: 'conv-1',
        rebindTo: 'conv-messaged',
        rebindAgentPageId: 'agent-3',
      });
    });
  });

  describe('the session\'s LAST open listing', () => {
    it('ends the session even though other (terminal) panes remain in the grid', () => {
      expect(
        decideClosePane({
          panes: [chatPane('p1', 'conv-1'), terminalPane('p2')],
          paneId: 'p1',
          activeConversations: [listing('conv-1')],
        }),
      ).toEqual({ action: 'end-session' });
    });

    it('ends the session when it is also the grid\'s only pane', () => {
      expect(
        decideClosePane({ panes: [chatPane('p1', 'conv-1')], paneId: 'p1', activeConversations: [listing('conv-1')] }),
      ).toEqual({ action: 'end-session' });
    });
  });
});
