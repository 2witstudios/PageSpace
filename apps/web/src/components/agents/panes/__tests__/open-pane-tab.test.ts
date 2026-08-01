/**
 * The "+" chip's decision — deliberately opening a NEW tab alongside the
 * pane's active one, never replacing it. Reuse-before-mint: never a
 * duplicate tab for an agent already open in this pane, and never a
 * redundant mint for an agent already open elsewhere in the session.
 */
import { describe, it, expect } from 'vitest';
import { decideOpenTab, type SessionConversationSummary } from '../open-pane-tab';

const conversation = (
  conversationId: string,
  agentPageId: string | null,
  lastMessageAt: string | null = null,
): SessionConversationSummary => ({ conversationId, agentPageId, lastMessageAt });

describe('decideOpenTab', () => {
  it('given the agent already has a tab in this pane, should focus it rather than duplicate', () => {
    expect(
      decideOpenTab({
        paneTabs: [conversation('conv-1', 'agent-1'), conversation('conv-2', 'agent-2')],
        sessionConversations: [conversation('conv-1', 'agent-1'), conversation('conv-2', 'agent-2')],
        selectedAgentPageId: 'agent-2',
      }),
    ).toEqual({ action: 'focus', conversationId: 'conv-2' });
  });

  it('given no tab for the picked agent in this pane but an open conversation elsewhere in the session, should reuse it (no mint)', () => {
    expect(
      decideOpenTab({
        paneTabs: [conversation('conv-1', 'agent-1')],
        sessionConversations: [conversation('conv-1', 'agent-1'), conversation('conv-elsewhere', 'agent-2')],
        selectedAgentPageId: 'agent-2',
      }),
    ).toEqual({ action: 'focus-existing', conversationId: 'conv-elsewhere' });
  });

  it('given no conversation for the picked agent anywhere, should mint a new one', () => {
    expect(
      decideOpenTab({
        paneTabs: [conversation('conv-1', 'agent-1')],
        sessionConversations: [conversation('conv-1', 'agent-1')],
        selectedAgentPageId: 'agent-2',
      }),
    ).toEqual({ action: 'mint' });
  });

  it('given a pane with no tabs and an empty session, should mint', () => {
    expect(
      decideOpenTab({ paneTabs: [], sessionConversations: [], selectedAgentPageId: 'agent-1' }),
    ).toEqual({ action: 'mint' });
  });

  it('given the pane\'s ACTIVE agent picked again, should focus its existing tab rather than open a duplicate', () => {
    // Unlike selectPaneAgent's same-agent no-op, "+" has no notion of "the
    // pane's current agent" to compare against — every pick here is "open
    // this agent as a tab," and a tab already open for it is focused, full
    // stop. Two tabs on the SAME agent is a legitimate, if unusual, state
    // (e.g. two independent threads with the global assistant) reachable by
    // closing the first tab's match before picking again.
    expect(
      decideOpenTab({
        paneTabs: [conversation('conv-1', 'agent-1')],
        sessionConversations: [conversation('conv-1', 'agent-1')],
        selectedAgentPageId: 'agent-1',
      }),
    ).toEqual({ action: 'focus', conversationId: 'conv-1' });
  });

  it('given several tabs for the picked agent, should focus the most recently active one', () => {
    expect(
      decideOpenTab({
        paneTabs: [
          conversation('conv-old', 'agent-2', '2026-01-01T00:00:00.000Z'),
          conversation('conv-new', 'agent-2', '2026-01-15T00:00:00.000Z'),
        ],
        sessionConversations: [],
        selectedAgentPageId: 'agent-2',
      }),
    ).toEqual({ action: 'focus', conversationId: 'conv-new' });
  });

  it('given several session-wide conversations for the picked agent (none in this pane), should reuse the most recently active one', () => {
    expect(
      decideOpenTab({
        paneTabs: [],
        sessionConversations: [
          conversation('conv-old', 'agent-2', '2026-01-01T00:00:00.000Z'),
          conversation('conv-new', 'agent-2', '2026-01-15T00:00:00.000Z'),
        ],
        selectedAgentPageId: 'agent-2',
      }),
    ).toEqual({ action: 'focus-existing', conversationId: 'conv-new' });
  });

  it('given a null agentPageId (Global Assistant), should match on it like any other agent', () => {
    expect(
      decideOpenTab({
        paneTabs: [conversation('conv-1', null)],
        sessionConversations: [conversation('conv-1', null)],
        selectedAgentPageId: null,
      }),
    ).toEqual({ action: 'focus', conversationId: 'conv-1' });
  });
});
