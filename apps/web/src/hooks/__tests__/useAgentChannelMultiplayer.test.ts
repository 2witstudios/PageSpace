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

const { mockLoadAgentConversationMessages, mockRefreshConversationSnapshot } = vi.hoisted(() => ({
  mockLoadAgentConversationMessages: vi.fn().mockResolvedValue(undefined),
  mockRefreshConversationSnapshot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/hooks/conversationMessagesLoaders', () => ({
  loadAgentConversationMessages: mockLoadAgentConversationMessages,
  refreshConversationSnapshot: mockRefreshConversationSnapshot,
}));

// Real Zustand stores imported AFTER mocks. useConversationMessagesStore is REAL:
// the hook's message callbacks are cache writes now (PR 5B, leaf 5.6), and the
// behavior under test is what lands in the cache.
import { usePageAgentDashboardStore } from '@/stores/page-agents';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import { useAgentChannelMultiplayer } from '../useAgentChannelMultiplayer';

const CONV_ID = 'conv-1';
const AGENT = { id: 'agent-1' };

const baseOptions = (
  overrides: Partial<Parameters<typeof useAgentChannelMultiplayer>[0]>,
): Parameters<typeof useAgentChannelMultiplayer>[0] => ({
  selectedAgent: null,
  agentConversationId: null,
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
    useConversationMessagesStore.setState({ byConversationId: {} });
  });

  const cacheMessages = (conversationId: string) =>
    useConversationMessagesStore.getState().getEntry(conversationId).messages;

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

  describe('stream complete → cache commit (leaf 5.6.1: replace-by-id vs reload)', () => {
    const streamFixture = (overrides: Partial<{ messageId: string; conversationId: string; parts: UIMessage['parts']; isOwn: boolean }>) => ({
      messageId: 'msg-done',
      pageId: AGENT.id,
      conversationId: 'conv-active',
      triggeredBy: { userId: 'me', displayName: 'Me' },
      parts: [{ type: 'text' as const, text: 'final response text' }],
      isOwn: true,
      ...overrides,
    });

    it('given OUR OWN stream finalizes for the active conversation, the synthesized assistant message should be committed to the conversation cache', () => {
      pendingStreams.current = new Map([[ 'msg-done', streamFixture({}) ]]);

      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: 'conv-active' }));

      act(() => {
        capturedChannel.options?.onStreamComplete?.('msg-done');
      });

      expect(cacheMessages('conv-active')).toEqual([
        { id: 'msg-done', role: 'assistant', parts: [{ type: 'text', text: 'final response text' }], status: 'complete' },
      ]);
    });

    // Epic leaf 6.8 (D ixpwr76xepu2x9v4pxgksyhz): a crash-reaped or Stopped stream must badge
    // 'interrupted' the instant a live-open tab hears chat:stream_complete's aborted flag —
    // not only after the next reload.
    it('given the stream was aborted, the committed message should carry status "interrupted"', () => {
      pendingStreams.current = new Map([[ 'msg-done', streamFixture({}) ]]);

      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: 'conv-active' }));

      act(() => {
        capturedChannel.options?.onStreamComplete?.('msg-done', 'conv-active', { joinFailed: false }, true);
      });

      expect(cacheMessages('conv-active')).toEqual([
        { id: 'msg-done', role: 'assistant', parts: [{ type: 'text', text: 'final response text' }], status: 'interrupted' },
      ]);
    });

    it("given ANOTHER TAB's stream finalizes for the active conversation, its content should ALSO commit to the cache (the isOwn gate protected the transport array, which no longer receives writes)", () => {
      pendingStreams.current = new Map([[ 'msg-foreign', streamFixture({
        messageId: 'msg-foreign',
        parts: [{ type: 'text' as const, text: 'other tab reply' }],
        isOwn: false,
      }) ]]);

      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: 'conv-active' }));

      act(() => {
        capturedChannel.options?.onStreamComplete?.('msg-foreign');
      });

      expect(cacheMessages('conv-active')).toEqual([
        { id: 'msg-foreign', role: 'assistant', parts: [{ type: 'text', text: 'other tab reply' }], status: 'complete' },
      ]);
    });

    it('given the cache already holds a HALF-STREAMED row under the same id (includeStreaming placeholder), the commit should REPLACE it, not skip (the rejoin content-loss fix)', () => {
      useConversationMessagesStore.getState().applyServerSnapshot(
        'conv-active',
        useConversationMessagesStore.getState().beginServerSnapshot('conv-active'),
        [{ id: 'msg-done', role: 'assistant', parts: [{ type: 'text', text: 'half-stre' }] } as UIMessage],
      );
      pendingStreams.current = new Map([[ 'msg-done', streamFixture({}) ]]);

      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: 'conv-active' }));

      act(() => {
        capturedChannel.options?.onStreamComplete?.('msg-done');
      });

      expect(cacheMessages('conv-active')).toEqual([
        { id: 'msg-done', role: 'assistant', parts: [{ type: 'text', text: 'final response text' }], status: 'complete' },
      ]);
    });

    it('given a stream finalizes for a DIFFERENT conversation, nothing should be committed to the active conversation', () => {
      pendingStreams.current = new Map([[ 'msg-stale', streamFixture({
        messageId: 'msg-stale',
        conversationId: 'conv-different',
      }) ]]);

      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: 'conv-active' }));

      act(() => {
        capturedChannel.options?.onStreamComplete?.('msg-stale');
      });

      expect(cacheMessages('conv-active')).toEqual([]);
      expect(cacheMessages('conv-different')).toEqual([]);
    });

    it('given a completion with NO usable store entry for the active conversation (joinFailed / zero parts), should reload via the RAW cache loader — never the surface loadConversation, which also sets identity and pushes the URL', () => {
      pendingStreams.current = new Map([[ 'msg-empty', streamFixture({ messageId: 'msg-empty', parts: [] }) ]]);
      const loadConversation = vi.fn();

      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: 'conv-active', loadConversation }));

      act(() => {
        capturedChannel.options?.onStreamComplete?.('msg-empty', 'conv-active');
      });

      expect(mockLoadAgentConversationMessages).toHaveBeenCalledWith(AGENT.id, 'conv-active');
      expect(loadConversation).not.toHaveBeenCalled();
      expect(cacheMessages('conv-active')).toEqual([]);
    });

    it('given an OWN completion, should promote pending optimistic sends BEFORE the commit so the question renders above the reply (F1)', () => {
      useConversationMessagesStore.getState().addOptimisticSend('conv-active', {
        id: 'u-sent', role: 'user', parts: [{ type: 'text', text: 'my question' }],
      } as UIMessage);
      pendingStreams.current = new Map([[ 'msg-done', streamFixture({}) ]]);

      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: 'conv-active' }));

      act(() => {
        capturedChannel.options?.onStreamComplete?.('msg-done');
      });

      expect(cacheMessages('conv-active').map((m) => m.id)).toEqual(['u-sent', 'msg-done']);
      expect(useConversationMessagesStore.getState().getEntry('conv-active').optimisticSends).toEqual([]);
    });

    it("given ANOTHER TAB's completion, should NOT promote this tab's optimistic sends (a remote reply proves nothing about our rows)", () => {
      useConversationMessagesStore.getState().addOptimisticSend('conv-active', {
        id: 'u-unsent', role: 'user', parts: [{ type: 'text', text: 'still in flight' }],
      } as UIMessage);
      pendingStreams.current = new Map([[ 'msg-foreign', streamFixture({ messageId: 'msg-foreign', isOwn: false }) ]]);

      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: 'conv-active' }));

      act(() => {
        capturedChannel.options?.onStreamComplete?.('msg-foreign');
      });

      expect(cacheMessages('conv-active').map((m) => m.id)).toEqual(['msg-foreign']);
      expect(useConversationMessagesStore.getState().getEntry('conv-active').optimisticSends.map((m) => m.id)).toEqual(['u-unsent']);
    });

    it('given a completion commit, should fire the background snapshot heal (the socket broadcast can outrace the SSE tail — F6)', () => {
      pendingStreams.current = new Map([[ 'msg-done', streamFixture({}) ]]);

      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: 'conv-active' }));

      act(() => {
        capturedChannel.options?.onStreamComplete?.('msg-done');
      });

      expect(mockRefreshConversationSnapshot).toHaveBeenCalledWith(AGENT.id, 'conv-active');
    });

    it('given a zero-parts completion for a DIFFERENT conversation, should neither commit nor reload', () => {
      pendingStreams.current = new Map();
      const loadConversation = vi.fn();

      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: 'conv-active', loadConversation }));

      act(() => {
        capturedChannel.options?.onStreamComplete?.('msg-x', 'conv-different');
      });

      expect(loadConversation).not.toHaveBeenCalled();
    });
  });

  describe('remote user-message broadcast → cache append', () => {
    const remoteUser = { id: 'u-1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'remote prompt' }] };
    const payloadFor = (conversationId: string) => ({
      message: remoteUser,
      pageId: AGENT.id,
      conversationId,
      triggeredBy: { userId: 'other', displayName: 'Other', browserSessionId: 'sess-x' },
    });

    it('given onUserMessage fires for the active agent conversation, should append the message to its cache entry', () => {
      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: 'conv-active' }));

      act(() => {
        capturedChannel.options?.onUserMessage?.(remoteUser, payloadFor('conv-active'));
      });

      expect(cacheMessages('conv-active')).toEqual([remoteUser]);
    });

    it('given onUserMessage fires for a different conversationId, should not write the active cache entry', () => {
      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: 'conv-active' }));

      act(() => {
        capturedChannel.options?.onUserMessage?.(remoteUser, payloadFor('conv-different'));
      });

      expect(cacheMessages('conv-active')).toEqual([]);
    });

    it('given onUserMessage fires twice for the same id (co-mounted surfaces both deliver), the append should be idempotent', () => {
      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: 'conv-active' }));

      act(() => {
        capturedChannel.options?.onUserMessage?.(remoteUser, payloadFor('conv-active'));
        capturedChannel.options?.onUserMessage?.(remoteUser, payloadFor('conv-active'));
      });

      expect(cacheMessages('conv-active')).toEqual([remoteUser]);
    });

    it("given onMessageEdited fires for the active conversation, the cache row's parts should be replaced", () => {
      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: 'conv-active' }));

      act(() => {
        capturedChannel.options?.onUserMessage?.(remoteUser, payloadFor('conv-active'));
        capturedChannel.options?.onMessageEdited?.({
          messageId: 'u-1',
          pageId: AGENT.id,
          conversationId: 'conv-active',
          parts: [{ type: 'text', text: 'edited' }],
          editedAt: '2026-01-01T00:00:00.000Z',
          triggeredBy: { userId: 'other', displayName: 'Other', browserSessionId: 'sess-x' },
        });
      });

      expect(cacheMessages('conv-active')[0].parts).toEqual([{ type: 'text', text: 'edited' }]);
    });

    it('given onMessageDeleted fires for the active conversation, the cache row should be removed', () => {
      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: 'conv-active' }));

      act(() => {
        capturedChannel.options?.onUserMessage?.(remoteUser, payloadFor('conv-active'));
        capturedChannel.options?.onMessageDeleted?.({
          messageId: 'u-1',
          pageId: AGENT.id,
          conversationId: 'conv-active',
          triggeredBy: { userId: 'other', displayName: 'Other', browserSessionId: 'sess-x' },
        });
      });

      expect(cacheMessages('conv-active')).toEqual([]);
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
