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

const AGENT = { id: 'agent-1' };

const seedDashboard = (overrides: Partial<{ agentStopStreaming: (() => void) | null; isAgentStreaming: boolean }> = {}) => {
  usePageAgentDashboardStore.setState({
    isAgentStreaming: overrides.isAgentStreaming ?? false,
    agentStopStreaming: overrides.agentStopStreaming !== undefined ? overrides.agentStopStreaming : null,
  });
};

const baseOptions = (
  overrides: Partial<Parameters<typeof useAgentChannelMultiplayer>[0]>,
): Parameters<typeof useAgentChannelMultiplayer>[0] => ({
  selectedAgent: null,
  agentConversationId: null,
  setLocalMessages: vi.fn(),
  isLocallyStreaming: false,
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
    seedDashboard({ agentStopStreaming: null, isAgentStreaming: false });
  });

  describe('subscription', () => {
    it('given a selected agent, the channel-stream socket should be subscribed to the agent id', () => {
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-1',
      }));

      expect(capturedChannel.channelId).toBe(AGENT.id);
    });

    it('given selectedAgent is null, the channel-stream socket should be subscribed to undefined (no-op)', () => {
      renderWiring(baseOptions({}));

      expect(capturedChannel.channelId).toBeUndefined();
    });
  });

  describe('own-stream slot ownership', () => {
    it('given onOwnStreamBootstrap fires while the dashboard stop slot is empty, the slot should be claimed', () => {
      seedDashboard({ agentStopStreaming: null });
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-1',
      }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-own' });
      });

      const state = usePageAgentDashboardStore.getState();
      expect(typeof state.agentStopStreaming).toBe('function');
      expect(state.isAgentStreaming).toBe(true);
    });

    it('given onOwnStreamBootstrap fires while the slot is already populated, the existing slot should be preserved', () => {
      const existingStop = vi.fn();
      seedDashboard({ agentStopStreaming: existingStop });
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-1',
      }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-own' });
      });

      expect(usePageAgentDashboardStore.getState().agentStopStreaming).toBe(existingStop);
    });

    it('given onOwnStreamFinalize fires after this surface claimed the slot, the slot should be cleared', () => {
      seedDashboard({ agentStopStreaming: null });
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-1',
      }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-own' });
      });
      act(() => {
        capturedChannel.options?.onOwnStreamFinalize?.({ messageId: 'msg-own' });
      });

      const state = usePageAgentDashboardStore.getState();
      expect(state.agentStopStreaming).toBeNull();
      expect(state.isAgentStreaming).toBe(false);
    });

    it('given onOwnStreamFinalize fires when this surface never claimed the slot, the existing stop should remain', () => {
      const otherSurfaceStop = vi.fn();
      seedDashboard({ agentStopStreaming: otherSurfaceStop });
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-1',
      }));

      // Bootstrap fires but slot is occupied; this surface declines to claim.
      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-own' });
      });
      // Finalize arrives — must NOT clear the other surface's slot.
      act(() => {
        capturedChannel.options?.onOwnStreamFinalize?.({ messageId: 'msg-own' });
      });

      expect(usePageAgentDashboardStore.getState().agentStopStreaming).toBe(otherSurfaceStop);
    });

    it("given the slot is claimed, calling the stop function in the slot should invoke the abort endpoint", () => {
      seedDashboard({ agentStopStreaming: null });
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-1',
      }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-own' });
      });

      const stop = usePageAgentDashboardStore.getState().agentStopStreaming;
      stop?.();

      expect(mockAbortByMessageId).toHaveBeenCalledWith({ messageId: 'msg-own' });
    });
  });

  describe('local message synthesis on stream complete', () => {
    it("given a stream finalizes whose conversationId matches the active agent conversation, the synthesized assistant message should be appended via setLocalMessages", () => {
      pendingStreams.current = new Map([
        [
          'msg-done',
          {
            messageId: 'msg-done',
            pageId: AGENT.id,
            conversationId: 'conv-active',
            triggeredBy: { userId: 'someone-else', displayName: 'X' },
            parts: [{ type: 'text', text: 'final response text' }],
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
      seedDashboard();
      const surfaceLoadConversation = vi.fn();
      mockSocketStatus.current = 'disconnected';
      const result = renderHook(
        ({ status }: { status: 'disconnected' | 'connecting' | 'connected' | 'error' }) => {
          mockSocketStatus.current = status;
          return useAgentChannelMultiplayer(baseOptions({
            selectedAgent: AGENT,
            agentConversationId: 'conv-1',
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
      seedDashboard();
      const surfaceLoadConversation = vi.fn();
      mockSocketStatus.current = 'disconnected';
      const result = renderHook(
        ({ status }: { status: 'disconnected' | 'connecting' | 'connected' | 'error' }) => {
          mockSocketStatus.current = status;
          return useAgentChannelMultiplayer(baseOptions({
            selectedAgent: AGENT,
            agentConversationId: 'conv-1',
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
      seedDashboard();
      const dashboardLoad = vi.fn();
      usePageAgentDashboardStore.setState({ loadConversation: dashboardLoad });
      const surfaceLoadConversation = vi.fn();

      mockSocketStatus.current = 'disconnected';
      const result = renderHook(
        ({ status }: { status: 'disconnected' | 'connecting' | 'connected' | 'error' }) => {
          mockSocketStatus.current = status;
          return useAgentChannelMultiplayer(baseOptions({
            selectedAgent: AGENT,
            agentConversationId: 'conv-1',
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
      seedDashboard();
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

  describe('cleanup on unmount', () => {
    it('given this surface claimed the dashboard stop slot then unmounts mid-stream, the slot should be cleared on cleanup', () => {
      seedDashboard({ agentStopStreaming: null });
      const { unmount } = renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-1',
      }));

      // Bootstrap claims the slot.
      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-own' });
      });
      expect(typeof usePageAgentDashboardStore.getState().agentStopStreaming).toBe('function');

      // Surface unmounts before stream finalizes (e.g. user navigates away).
      // useChannelStreamSocket aborts the controller but does NOT fire
      // onOwnStreamFinalize, so the hook's own cleanup must clear the slot.
      unmount();

      const state = usePageAgentDashboardStore.getState();
      expect(state.agentStopStreaming).toBeNull();
      expect(state.isAgentStreaming).toBe(false);
    });

    it('given this surface never claimed the slot, unmount should NOT clear another writer\'s slot', () => {
      const otherSurfaceStop = vi.fn();
      seedDashboard({ agentStopStreaming: otherSurfaceStop, isAgentStreaming: true });
      const { unmount } = renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-1',
      }));

      // Bootstrap fires but slot is occupied — this surface declines.
      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-own' });
      });
      // Surface unmounts. The other writer's slot must survive.
      unmount();

      expect(usePageAgentDashboardStore.getState().agentStopStreaming).toBe(otherSurfaceStop);
      expect(usePageAgentDashboardStore.getState().isAgentStreaming).toBe(true);
    });
  });

  describe('editing-store registration', () => {
    it('given a selected agent, the registration key should be `ai-channel-${agent.id}`', () => {
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-1',
        isLocallyStreaming: true,
      }));

      const lastCall = mockUseStreamingRegistration.mock.calls.at(-1);
      expect(lastCall?.[0]).toBe(`ai-channel-${AGENT.id}`);
      expect(lastCall?.[1]).toBe(true); // isLocallyStreaming → registration true
    });

    it('given selectedAgent is null, the registration should be inactive (isStreaming=false)', () => {
      renderWiring(baseOptions({
        isLocallyStreaming: true,
      }));

      const lastCall = mockUseStreamingRegistration.mock.calls.at(-1);
      expect(lastCall?.[1]).toBe(false);
    });

    it('given an agent and the dashboard store reports streaming (e.g. bootstrap-replay), the registration should be active even if the surface itself is not streaming', () => {
      seedDashboard({ isAgentStreaming: true });
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-1',
      }));

      const lastCall = mockUseStreamingRegistration.mock.calls.at(-1);
      expect(lastCall?.[1]).toBe(true);
    });
  });
});
