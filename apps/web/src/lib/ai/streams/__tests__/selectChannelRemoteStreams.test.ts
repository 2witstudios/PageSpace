import { describe, it, expect } from 'vitest';
import { selectChannelRemoteStreams } from '../selectChannelRemoteStreams';
import type { PendingStream } from '@/stores/usePendingStreamsStore';

const stream = (overrides: Partial<PendingStream>): PendingStream => ({
  messageId: 'msg-1',
  pageId: 'channel-1',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'user-1', displayName: 'U' },
  text: '',
  isOwn: false,
  ...overrides,
});

const stateFrom = (streamsByChannel: Record<string, PendingStream[]>) => ({
  getRemotePageStreams: (channelId: string): PendingStream[] => streamsByChannel[channelId] ?? [],
});

describe('selectChannelRemoteStreams', () => {
  describe('agent mode', () => {
    it('given a selected agent and a matching agent conversation, should return streams from the agent channel filtered by the agent conversation id', () => {
      const state = stateFrom({
        'agent-1': [
          stream({ messageId: 'm1', pageId: 'agent-1', conversationId: 'conv-active' }),
          stream({ messageId: 'm2', pageId: 'agent-1', conversationId: 'conv-other' }),
        ],
      });

      const result = selectChannelRemoteStreams(state, {
        selectedAgent: { id: 'agent-1' },
        agentConversationId: 'conv-active',
        globalChannelId: 'user:u:global',
        globalConversationId: 'g-1',
      });

      expect(result.map((s) => s.messageId)).toEqual(['m1']);
    });

    it('given a selected agent but no agent conversation id yet, should return []', () => {
      const state = stateFrom({
        'agent-1': [stream({ messageId: 'm1', pageId: 'agent-1', conversationId: 'whatever' })],
      });

      const result = selectChannelRemoteStreams(state, {
        selectedAgent: { id: 'agent-1' },
        agentConversationId: null,
        globalChannelId: 'user:u:global',
        globalConversationId: 'g-1',
      });

      expect(result).toEqual([]);
    });

    it('given a selected agent, should NOT return streams from the global channel even if globalChannelId is populated', () => {
      const state = stateFrom({
        'agent-1': [],
        'user:u:global': [stream({ messageId: 'm-global', pageId: 'user:u:global', conversationId: 'g-1' })],
      });

      const result = selectChannelRemoteStreams(state, {
        selectedAgent: { id: 'agent-1' },
        agentConversationId: 'conv-active',
        globalChannelId: 'user:u:global',
        globalConversationId: 'g-1',
      });

      expect(result).toEqual([]);
    });
  });

  describe('global mode', () => {
    it('given selectedAgent is null and a matching global conversation, should return streams from the global channel filtered by the global conversation id', () => {
      const state = stateFrom({
        'user:u:global': [
          stream({ messageId: 'm1', pageId: 'user:u:global', conversationId: 'g-active' }),
          stream({ messageId: 'm2', pageId: 'user:u:global', conversationId: 'g-other' }),
        ],
      });

      const result = selectChannelRemoteStreams(state, {
        selectedAgent: null,
        agentConversationId: null,
        globalChannelId: 'user:u:global',
        globalConversationId: 'g-active',
      });

      expect(result.map((s) => s.messageId)).toEqual(['m1']);
    });

    it('given selectedAgent is null but no global channel id (e.g. unauthenticated), should return []', () => {
      const state = stateFrom({
        'user:u:global': [stream({ messageId: 'm1', pageId: 'user:u:global', conversationId: 'g-1' })],
      });

      const result = selectChannelRemoteStreams(state, {
        selectedAgent: null,
        agentConversationId: null,
        globalChannelId: null,
        globalConversationId: 'g-1',
      });

      expect(result).toEqual([]);
    });

    it('given selectedAgent is null but no global conversation id loaded yet, should return []', () => {
      const state = stateFrom({
        'user:u:global': [stream({ messageId: 'm1', pageId: 'user:u:global', conversationId: 'g-1' })],
      });

      const result = selectChannelRemoteStreams(state, {
        selectedAgent: null,
        agentConversationId: null,
        globalChannelId: 'user:u:global',
        globalConversationId: null,
      });

      expect(result).toEqual([]);
    });
  });
});
