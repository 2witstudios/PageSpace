/**
 * The pane bar selector's switch decision as data — a two-way question:
 * already open somewhere in the session (focus-existing, reuse without
 * minting), or not (mint) — and never when the pick is the pane's own current
 * agent.
 *
 * Deliberately NOT a cross-pane dedup: an agent already open in a DIFFERENT
 * pane still reaches `focus-existing`, not a jump to that other pane —
 * confirmed decision, "no reason you can't have the same agent open twice
 * ... it just replaces the agent that was there ... with its own view of
 * that conversation, even if another pane also shows it."
 */
import { describe, it, expect } from 'vitest';
import { selectPaneAgent, type SessionConversationSummary } from '../select-pane-agent';

const conversation = (
  conversationId: string,
  agentPageId: string | null,
  lastMessageAt: string | null = null,
): SessionConversationSummary => ({ conversationId, agentPageId, lastMessageAt });

describe('selectPaneAgent', () => {
  it('given the pane is already on the picked agent, should no-op', () => {
    expect(
      selectPaneAgent({
        sessionConversations: [conversation('conv-1', 'agent-1')],
        selectedAgentPageId: 'agent-1',
        currentAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'noop' });
  });

  it('given the pane is already on the Global Assistant and Assistant is picked again, should no-op', () => {
    expect(
      selectPaneAgent({
        sessionConversations: [conversation('conv-1', null)],
        selectedAgentPageId: null,
        currentAgentPageId: null,
      }),
    ).toEqual({ action: 'noop' });
  });

  it('given an open conversation for the picked agent elsewhere in the session, should focus-existing (reuse, no mint)', () => {
    expect(
      selectPaneAgent({
        sessionConversations: [conversation('conv-1', 'agent-1'), conversation('conv-elsewhere', 'agent-2')],
        selectedAgentPageId: 'agent-2',
        currentAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'focus-existing', conversationId: 'conv-elsewhere' });
  });

  it('given no conversation for the picked agent anywhere, should mint', () => {
    expect(
      selectPaneAgent({
        sessionConversations: [conversation('conv-1', 'agent-1')],
        selectedAgentPageId: 'agent-2',
        currentAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'mint' });
  });

  it('given an empty session, should mint', () => {
    expect(
      selectPaneAgent({
        sessionConversations: [],
        selectedAgentPageId: 'agent-2',
        currentAgentPageId: null,
      }),
    ).toEqual({ action: 'mint' });
  });

  it('given the SAME agent already open in a DIFFERENT pane, should focus-existing — no cross-pane dedup, but no needless mint either', () => {
    // The confirmed decision: it's fine for the same agent to end up open in
    // two panes at once, but that means REUSING the existing conversation
    // (bringing it into this pane too), never minting a redundant duplicate.
    expect(
      selectPaneAgent({
        sessionConversations: [conversation('conv-1', 'agent-1'), conversation('conv-open-elsewhere', 'agent-2')],
        selectedAgentPageId: 'agent-2',
        currentAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'focus-existing', conversationId: 'conv-open-elsewhere' });
  });

  it('given several session-wide conversations for the picked agent, should focus the most recently active one', () => {
    expect(
      selectPaneAgent({
        sessionConversations: [
          conversation('conv-old', 'agent-2', '2026-01-01T00:00:00.000Z'),
          conversation('conv-new', 'agent-2', '2026-01-15T00:00:00.000Z'),
        ],
        selectedAgentPageId: 'agent-2',
        currentAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'focus-existing', conversationId: 'conv-new' });
  });
});
