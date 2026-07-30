/**
 * The pane bar selector's switch decision as data — the rule worth pinning is
 * that switching a pane's agent never invents a target: it either finds the
 * session's existing conversation with that agent, or defers to a mint, and
 * never when the pick is the pane's own current agent.
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
        conversations: [conversation('conv-1', 'agent-1')],
        selectedAgentPageId: 'agent-1',
        currentAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'noop' });
  });

  it('given the pane is already on the Global Assistant and Assistant is picked again, should no-op', () => {
    expect(
      selectPaneAgent({
        conversations: [conversation('conv-1', null)],
        selectedAgentPageId: null,
        currentAgentPageId: null,
      }),
    ).toEqual({ action: 'noop' });
  });

  it('given the session already has a conversation with the picked agent, should focus it', () => {
    expect(
      selectPaneAgent({
        conversations: [conversation('conv-1', 'agent-1'), conversation('conv-2', 'agent-2')],
        selectedAgentPageId: 'agent-2',
        currentAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'focus', conversationId: 'conv-2' });
  });

  it('given the session has no conversation with the picked agent, should mint one', () => {
    expect(
      selectPaneAgent({
        conversations: [conversation('conv-1', 'agent-1')],
        selectedAgentPageId: 'agent-2',
        currentAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'mint' });
  });

  it('given an empty session, should mint', () => {
    expect(
      selectPaneAgent({
        conversations: [],
        selectedAgentPageId: 'agent-2',
        currentAgentPageId: null,
      }),
    ).toEqual({ action: 'mint' });
  });

  it('given several conversations with the picked agent, should focus the most recently active one', () => {
    expect(
      selectPaneAgent({
        conversations: [
          conversation('conv-old', 'agent-2', '2026-01-01T00:00:00.000Z'),
          conversation('conv-new', 'agent-2', '2026-01-15T00:00:00.000Z'),
          conversation('conv-mid', 'agent-2', '2026-01-08T00:00:00.000Z'),
        ],
        selectedAgentPageId: 'agent-2',
        currentAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'focus', conversationId: 'conv-new' });
  });

  it('given the picked agent has both a never-messaged and a messaged conversation, should focus the messaged one', () => {
    expect(
      selectPaneAgent({
        conversations: [
          conversation('conv-never', 'agent-2', null),
          conversation('conv-messaged', 'agent-2', '2026-01-01T00:00:00.000Z'),
        ],
        selectedAgentPageId: 'agent-2',
        currentAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'focus', conversationId: 'conv-messaged' });
  });

  it('switching from the Assistant to a drive agent with an existing thread should focus it, not mint', () => {
    expect(
      selectPaneAgent({
        conversations: [conversation('conv-assistant', null), conversation('conv-agent', 'agent-1')],
        selectedAgentPageId: 'agent-1',
        currentAgentPageId: null,
      }),
    ).toEqual({ action: 'focus', conversationId: 'conv-agent' });
  });
});
