import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { UIMessage } from 'ai';
import type { UseChannelStreamSocketOptions } from '@/hooks/useChannelStreamSocket';

// ---------------------------------------------------------------------------
// Hoisted state captured from the dependency hooks under test
// ---------------------------------------------------------------------------
const {
  capturedChannel,
  mockUseChannelStreamSocket,
  mockUsePageSocketRoom,
  mockUseStreamingRegistration,
  mockAbortByMessageId,
  mockSocketStatus,
  pendingStreams,
} = vi.hoisted(() => {
  const ref: { channelId: string | undefined; options: UseChannelStreamSocketOptions | undefined } = {
    channelId: undefined,
    options: undefined,
  };
  return {
    capturedChannel: ref,
    mockUseChannelStreamSocket: vi.fn(),
    mockUsePageSocketRoom: vi.fn(),
    mockUseStreamingRegistration: vi.fn(),
    mockAbortByMessageId: vi.fn(),
    mockSocketStatus: { current: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'error' },
    pendingStreams: { current: new Map<string, { messageId: string; pageId: string; conversationId: string; triggeredBy: { userId: string; displayName: string }; parts: UIMessage['parts']; isOwn: boolean }>() },
  };
});

vi.mock('@/hooks/useChannelStreamSocket', () => ({
  useChannelStreamSocket: (channelId: string | undefined, options?: UseChannelStreamSocketOptions) => {
    capturedChannel.channelId = channelId;
    capturedChannel.options = options;
    mockUseChannelStreamSocket(channelId, options);
    return { rejoinActiveStreams: vi.fn() };
  },
}));

vi.mock('@/hooks/usePageSocketRoom', () => ({
  usePageSocketRoom: mockUsePageSocketRoom,
}));

vi.mock('@/stores/useSocketStore', () => ({
  useSocketStore: vi.fn((selector: (s: { connectionStatus: string }) => unknown) =>
    selector({ connectionStatus: mockSocketStatus.current }),
  ),
}));

vi.mock('@/stores/usePendingStreamsStore', () => ({
  usePendingStreamsStore: Object.assign(vi.fn(() => []), {
    getState: vi.fn(() => ({ streams: pendingStreams.current })),
  }),
}));

vi.mock('@/lib/ai/shared', () => ({
  useStreamingRegistration: mockUseStreamingRegistration,
}));

vi.mock('@/lib/ai/core/stream-abort-client', () => ({
  abortActiveStreamByMessageId: mockAbortByMessageId,
}));

// Real Zustand store imported AFTER mocks
import { usePageAgentDashboardStore } from '@/stores/page-agents';
import { useAgentChannelMultiplayer } from '../useAgentChannelMultiplayer';

const CONV_ID = 'conv-1';
const AGENT = { id: 'agent-1' };

const baseOptions = (
  overrides: Partial<Parameters<typeof useAgentChannelMultiplayer>[0]>,
): Parameters<typeof useAgentChannelMultiplayer>[0] => ({
  selectedAgent: null,
  agentConversationId: null,
  setLocalMessages: vi.fn(),
  surfaceComponentName: 'TestSurface',
  loadConversation: vi.fn(),
  ...overrides,
});

const renderWiring = (
  options: Parameters<typeof useAgentChannelMultiplayer>[0],
) => renderHook(({ opts }) => useAgentChannelMultiplayer(opts), {
  initialProps: { opts: options },
});

describe('useAgentChannelMultiplayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedChannel.channelId = undefined;
    capturedChannel.options = undefined;
    mockSocketStatus.current = 'disconnected';
    pendingStreams.current = new Map();
  });

  describe('subscription', () => {
    it('given a selected agent, the channel-stream socket should be subscribed to the agent id', () => {
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: CONV_ID,
      }));

      expect(capturedChannel.channelId).toBe(AGENT.id);
    });

    it('given selectedAgent is null, the channel-stream socket should be subscribed to undefined (no-op)', () => {
      renderWiring(baseOptions({}));

      expect(capturedChannel.channelId).toBeUndefined();
    });
  });

  describe('local message synthesis on stream complete', () => {
    it("given OUR OWN stream finalizes whose conversationId matches the active agent conversation, the synthesized assistant message should be appended via setLocalMessages", () => {
      pendingStreams.current = new Map([
        [
          'msg-done',
          {
            messageId: 'msg-done',
            pageId: AGENT.id,
            conversationId: 'conv-active',
            triggeredBy: { userId: 'me', displayName: 'Me' },
            parts: [{ type: 'text', text: 'final response text' }],
            // OUR OWN stream. This dual-write is local bookkeeping for the tab that made the
            // request; the fixture previously said `isOwn: false` (userId 'someone-else'), which
            // asserted that ANOTHER tab's finished reply gets appended into this chat's array —
            // encoding the bug rather than the contract. useOwnStreamMirror reads this array to
            // find its own live stream, so a foreign message landing after ours makes it
            // re-target onto a finished message. See the foreign-stream test below.
            isOwn: true,
          },
        ],
      ]);

      const setLocalMessages = vi.fn();
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-active',
        setLocalMessages,
      }));

      act(() => {
        capturedChannel.options?.onStreamComplete?.('msg-done');
      });

      expect(setLocalMessages).toHaveBeenCalledTimes(1);
      const updater = setLocalMessages.mock.calls[0][0] as (prev: UIMessage[]) => UIMessage[];
      expect(updater([])).toEqual([
        {
          id: 'msg-done',
          role: 'assistant',
          parts: [{ type: 'text', text: 'final response text' }],
        },
      ]);
    });

    it("given a stream finalizes whose conversationId does not match the active agent conversation, setLocalMessages should not be called", () => {
      pendingStreams.current = new Map([
        [
          'msg-stale',
          {
            messageId: 'msg-stale',
            pageId: AGENT.id,
            conversationId: 'conv-different',
            triggeredBy: { userId: 'x', displayName: 'X' },
            parts: [{ type: 'text', text: 'belongs to different conversation' }],
            isOwn: false,
          },
        ],
      ]);

      const setLocalMessages = vi.fn();
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-active',
        setLocalMessages,
      }));

      act(() => {
        capturedChannel.options?.onStreamComplete?.('msg-stale');
      });

      expect(setLocalMessages).not.toHaveBeenCalled();
    });

    it('given a stream finalizes with empty parts, setLocalMessages should not be called', () => {
      pendingStreams.current = new Map([
        [
          'msg-empty',
          {
            messageId: 'msg-empty',
            pageId: AGENT.id,
            conversationId: 'conv-active',
            triggeredBy: { userId: 'x', displayName: 'X' },
            parts: [],
            isOwn: false,
          },
        ],
      ]);

      const setLocalMessages = vi.fn();
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-active',
        setLocalMessages,
      }));

      act(() => {
        capturedChannel.options?.onStreamComplete?.('msg-empty');
      });

      expect(setLocalMessages).not.toHaveBeenCalled();
    });
  });

  describe('remote user-message broadcast', () => {
    it('given onUserMessage fires with conversationId matching the active agent conversation, should append via setLocalMessages', () => {
      const setLocalMessages = vi.fn();
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-active',
        setLocalMessages,
      }));

      const remoteUser = { id: 'u-1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'remote prompt' }] };
      act(() => {
        capturedChannel.options?.onUserMessage?.(remoteUser, {
          message: remoteUser,
          pageId: AGENT.id,
          conversationId: 'conv-active',
          triggeredBy: { userId: 'other', displayName: 'Other', browserSessionId: 'sess-x' },
        });
      });

      expect(setLocalMessages).toHaveBeenCalledTimes(1);
      const updater = setLocalMessages.mock.calls[0][0] as (prev: UIMessage[]) => UIMessage[];
      expect(updater([])).toEqual([remoteUser]);
    });

    it('given onUserMessage fires for a different conversationId, should NOT call setLocalMessages', () => {
      const setLocalMessages = vi.fn();
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-active',
        setLocalMessages,
      }));

      const remoteUser = { id: 'u-1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'wrong conv' }] };
      act(() => {
        capturedChannel.options?.onUserMessage?.(remoteUser, {
          message: remoteUser,
          pageId: AGENT.id,
          conversationId: 'conv-different',
          triggeredBy: { userId: 'other', displayName: 'Other', browserSessionId: 'sess-x' },
        });
      });

      expect(setLocalMessages).not.toHaveBeenCalled();
    });

    it('given onUserMessage fires for a messageId already in messages, the updater should leave the array unchanged', () => {
      const setLocalMessages = vi.fn();
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-active',
        setLocalMessages,
      }));

      const remoteUser = { id: 'u-already', role: 'user' as const, parts: [{ type: 'text' as const, text: 'dup' }] };
      act(() => {
        capturedChannel.options?.onUserMessage?.(remoteUser, {
          message: remoteUser,
          pageId: AGENT.id,
          conversationId: 'conv-active',
          triggeredBy: { userId: 'other', displayName: 'Other', browserSessionId: 'sess-x' },
        });
      });

      const updater = setLocalMessages.mock.calls[0][0] as (prev: UIMessage[]) => UIMessage[];
      const prev = [remoteUser];
      expect(updater(prev)).toBe(prev); // same reference — no append happened
    });
  });

  describe('reconnect refresh', () => {
    it('given the very first connect, the surface-provided loadConversation should NOT be called (mount-time load already covers it)', () => {
      const surfaceLoadConversation = vi.fn();
      mockSocketStatus.current = 'disconnected';
      const result = renderHook(
        ({ status }: { status: 'disconnected' | 'connecting' | 'connected' | 'error' }) => {
          mockSocketStatus.current = status;
          return useAgentChannelMultiplayer(baseOptions({
            selectedAgent: AGENT,
            agentConversationId: CONV_ID,
            loadConversation: surfaceLoadConversation,
          }));
        },
        {
          initialProps: {
            status: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'error',
          },
        },
      );

      // First connect.
      result.rerender({ status: 'connected' });
      expect(surfaceLoadConversation).not.toHaveBeenCalled();
    });

    it('given a reconnect AFTER the initial connect, the surface-provided loadConversation should be called with the active conversation id', () => {
      const surfaceLoadConversation = vi.fn();
      mockSocketStatus.current = 'disconnected';
      const result = renderHook(
        ({ status }: { status: 'disconnected' | 'connecting' | 'connected' | 'error' }) => {
          mockSocketStatus.current = status;
          return useAgentChannelMultiplayer(baseOptions({
            selectedAgent: AGENT,
            agentConversationId: CONV_ID,
            loadConversation: surfaceLoadConversation,
          }));
        },
        {
          initialProps: {
            status: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'error',
          },
        },
      );

      // First connect — primes hasInitialConnect, no refresh.
      result.rerender({ status: 'connected' });
      expect(surfaceLoadConversation).not.toHaveBeenCalled();

      // Goes offline, then reconnects.
      result.rerender({ status: 'disconnected' });
      result.rerender({ status: 'connected' });

      expect(surfaceLoadConversation).toHaveBeenCalledTimes(1);
      expect(surfaceLoadConversation).toHaveBeenCalledWith('conv-1');
    });

    it('given a custom loadConversation is provided, the dashboard store loadConversation should NOT be called (the surface owns the refresh path — sidebar agent state vs dashboard state)', () => {
      const dashboardLoad = vi.fn();
      usePageAgentDashboardStore.setState({ loadConversation: dashboardLoad });
      const surfaceLoadConversation = vi.fn();

      mockSocketStatus.current = 'disconnected';
      const result = renderHook(
        ({ status }: { status: 'disconnected' | 'connecting' | 'connected' | 'error' }) => {
          mockSocketStatus.current = status;
          return useAgentChannelMultiplayer(baseOptions({
            selectedAgent: AGENT,
            agentConversationId: CONV_ID,
            loadConversation: surfaceLoadConversation,
          }));
        },
        {
          initialProps: {
            status: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'error',
          },
        },
      );

      // Initial connect, then reconnect.
      result.rerender({ status: 'connected' });
      result.rerender({ status: 'disconnected' });
      result.rerender({ status: 'connected' });

      expect(surfaceLoadConversation).toHaveBeenCalledWith('conv-1');
      expect(dashboardLoad).not.toHaveBeenCalled();
    });

    it('given selectedAgent is null, reconnect should never trigger a refresh', () => {
      const surfaceLoadConversation = vi.fn();
      const result = renderHook(
        ({ status }: { status: 'disconnected' | 'connecting' | 'connected' | 'error' }) => {
          mockSocketStatus.current = status;
          return useAgentChannelMultiplayer(baseOptions({
            loadConversation: surfaceLoadConversation,
          }));
        },
        {
          initialProps: {
            status: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'error',
          },
        },
      );

      result.rerender({ status: 'connected' });
      result.rerender({ status: 'disconnected' });
      result.rerender({ status: 'connected' });

      expect(surfaceLoadConversation).not.toHaveBeenCalled();
    });
  });


});
