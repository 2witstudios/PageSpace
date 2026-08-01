/**
 * The pane bar selector's switch decision as data — a three-way question:
 * already a tab in THIS pane (switch-tab, local), already open somewhere
 * else in the session (focus-existing, reuse without minting), or neither
 * (mint) — and never when the pick is the pane's own current agent.
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
        paneTabs: [conversation('conv-1', 'agent-1')],
        sessionConversations: [conversation('conv-1', 'agent-1')],
        selectedAgentPageId: 'agent-1',
        currentAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'noop' });
  });

  it('given the pane is already on the Global Assistant and Assistant is picked again, should no-op', () => {
    expect(
      selectPaneAgent({
        paneTabs: [conversation('conv-1', null)],
        sessionConversations: [conversation('conv-1', null)],
        selectedAgentPageId: null,
        currentAgentPageId: null,
      }),
    ).toEqual({ action: 'noop' });
  });

  it('given this pane already has a tab open for the picked agent, should switch to it (checked before the session-wide search)', () => {
    expect(
      selectPaneAgent({
        paneTabs: [conversation('conv-1', 'agent-1'), conversation('conv-2', 'agent-2')],
        sessionConversations: [conversation('conv-1', 'agent-1'), conversation('conv-2', 'agent-2')],
        selectedAgentPageId: 'agent-2',
        currentAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'switch-tab', conversationId: 'conv-2' });
  });

  it('given no tab in this pane but an open conversation elsewhere in the session, should focus-existing (reuse, no mint)', () => {
    expect(
      selectPaneAgent({
        paneTabs: [conversation('conv-1', 'agent-1')],
        sessionConversations: [conversation('conv-1', 'agent-1'), conversation('conv-elsewhere', 'agent-2')],
        selectedAgentPageId: 'agent-2',
        currentAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'focus-existing', conversationId: 'conv-elsewhere' });
  });

  it('given no conversation for the picked agent anywhere, should mint', () => {
    expect(
      selectPaneAgent({
        paneTabs: [conversation('conv-1', 'agent-1')],
        sessionConversations: [conversation('conv-1', 'agent-1')],
        selectedAgentPageId: 'agent-2',
        currentAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'mint' });
  });

  it('given a pane with no tabs and an empty session, should mint', () => {
    expect(
      selectPaneAgent({
        paneTabs: [],
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
        paneTabs: [conversation('conv-1', 'agent-1')], // this pane's own tabs — agent-2 isn't one
        sessionConversations: [conversation('conv-1', 'agent-1'), conversation('conv-open-elsewhere', 'agent-2')],
        selectedAgentPageId: 'agent-2',
        currentAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'focus-existing', conversationId: 'conv-open-elsewhere' });
  });

  it('given several of this pane\'s own tabs for the picked agent, should switch to the most recently active one', () => {
    expect(
      selectPaneAgent({
        paneTabs: [
          conversation('conv-old', 'agent-2', '2026-01-01T00:00:00.000Z'),
          conversation('conv-new', 'agent-2', '2026-01-15T00:00:00.000Z'),
          conversation('conv-mid', 'agent-2', '2026-01-08T00:00:00.000Z'),
        ],
        sessionConversations: [],
        selectedAgentPageId: 'agent-2',
        currentAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'switch-tab', conversationId: 'conv-new' });
  });

  it('given several session-wide conversations for the picked agent (none in this pane), should focus the most recently active one', () => {
    expect(
      selectPaneAgent({
        paneTabs: [],
        sessionConversations: [
          conversation('conv-old', 'agent-2', '2026-01-01T00:00:00.000Z'),
          conversation('conv-new', 'agent-2', '2026-01-15T00:00:00.000Z'),
        ],
        selectedAgentPageId: 'agent-2',
        currentAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'focus-existing', conversationId: 'conv-new' });
  });

  it('given the picked agent has both a never-messaged and a messaged tab in this pane, should switch to the messaged one', () => {
    expect(
      selectPaneAgent({
        paneTabs: [
          conversation('conv-never', 'agent-2', null),
          conversation('conv-messaged', 'agent-2', '2026-01-01T00:00:00.000Z'),
        ],
        sessionConversations: [],
        selectedAgentPageId: 'agent-2',
        currentAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'switch-tab', conversationId: 'conv-messaged' });
  });

  it('switching from the Assistant to a drive agent with an existing tab IN THIS PANE should switch to it, not mint', () => {
    expect(
      selectPaneAgent({
        paneTabs: [conversation('conv-assistant', null), conversation('conv-agent', 'agent-1')],
        sessionConversations: [conversation('conv-assistant', null), conversation('conv-agent', 'agent-1')],
        selectedAgentPageId: 'agent-1',
        currentAgentPageId: null,
      }),
    ).toEqual({ action: 'switch-tab', conversationId: 'conv-agent' });
  });
});
