import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------
const SESSION_ID_LOCAL = 'session-current';
const SESSION_ID_REMOTE = 'session-other';

const {
  mockSocket,
  mockAddStream,
  mockAppendText,
  mockRemoveStream,
  mockClearPageStreams,
  mockConsumeStreamJoin,
  mockFetchWithAuth,
  mockGetBrowserSessionId,
} = vi.hoisted(() => {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};

  const mockSocket = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (handlers[event]) {
        handlers[event] = handlers[event].filter((h) => h !== handler);
      }
    }),
    emit: vi.fn(),
    _trigger: (event: string, payload: unknown) => {
      handlers[event]?.slice().forEach((h) => h(payload));
    },
    _reset: () => {
      Object.keys(handlers).forEach((k) => { handlers[k] = []; });
    },
  };

  const mockAddStream = vi.fn();
  const mockAppendText = vi.fn();
  const mockRemoveStream = vi.fn();
  const mockClearPageStreams = vi.fn();
  const mockConsumeStreamJoin = vi.fn().mockResolvedValue({ aborted: false });
  const mockFetchWithAuth = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ streams: [] }),
  });
  const mockGetBrowserSessionId = vi.fn(() => 'session-current');

  return {
    mockSocket,
    mockAddStream,
    mockAppendText,
    mockRemoveStream,
    mockClearPageStreams,
    mockConsumeStreamJoin,
    mockFetchWithAuth,
    mockGetBrowserSessionId,
  };
});

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => mockSocket,
}));

vi.mock('@/stores/usePendingStreamsStore', () => ({
  usePendingStreamsStore: {
    getState: () => ({
      addStream: mockAddStream,
      appendText: mockAppendText,
      removeStream: mockRemoveStream,
      clearPageStreams: mockClearPageStreams,
    }),
  },
}));

vi.mock('@/lib/ai/core/stream-join-client', () => ({
  consumeStreamJoin: mockConsumeStreamJoin,
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
}));

vi.mock('@/lib/ai/core/browser-session-id', () => ({
  getBrowserSessionId: mockGetBrowserSessionId,
}));

import { useChannelStreamSocket } from '../useChannelStreamSocket';
import type { AiStreamStartPayload, AiStreamCompletePayload } from '@/lib/websocket/socket-utils';

const START_PAYLOAD: AiStreamStartPayload = {
  messageId: 'msg-1',
  pageId: 'page-a',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
};

const COMPLETE_PAYLOAD: AiStreamCompletePayload = {
  messageId: 'msg-1',
  pageId: 'page-a',
};

describe('useChannelStreamSocket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket._reset();
    mockConsumeStreamJoin.mockResolvedValue({ aborted: false });
    mockGetBrowserSessionId.mockReturnValue(SESSION_ID_LOCAL);
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ streams: [] }),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('chat:stream_start from another user', () => {
    it('should call addStream and start consumeStreamJoin', () => {
      renderHook(() => useChannelStreamSocket('page-a'));

      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      expect(mockAddStream).toHaveBeenCalledWith({
        messageId: 'msg-1',
        pageId: 'page-a',
        conversationId: 'conv-1',
        triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
        isOwn: false,
      });
      expect(mockConsumeStreamJoin).toHaveBeenCalledWith(
        'msg-1',
        expect.any(AbortSignal),
        expect.any(Function),
      );
    });

    it('should wire onChunk to appendText in the store', async () => {
      let capturedOnChunk!: (text: string) => void;
      mockConsumeStreamJoin.mockImplementation(
        (_id: string, _signal: AbortSignal, onChunk: (text: string) => void) => {
          capturedOnChunk = onChunk;
          return new Promise(() => {}); // never resolves
        },
      );

      renderHook(() => useChannelStreamSocket('page-a'));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      capturedOnChunk('hello');
      expect(mockAppendText).toHaveBeenCalledWith('msg-1', 'hello');
    });

    it('should call removeStream and onStreamComplete after consumeStreamJoin resolves', async () => {
      let resolveJoin!: () => void;
      mockConsumeStreamJoin.mockReturnValue(
        new Promise<{ aborted: boolean }>((res) => { resolveJoin = () => res({ aborted: false }); }),
      );
      const onStreamComplete = vi.fn();

      renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete }));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      await act(async () => { resolveJoin(); });

      expect(mockRemoveStream).toHaveBeenCalledWith('msg-1');
      expect(onStreamComplete).toHaveBeenCalledWith('msg-1');
    });

    it('should call onStreamComplete before removeStream so stream data is available in the callback (SSE path)', async () => {
      let resolveJoin!: () => void;
      mockConsumeStreamJoin.mockReturnValue(
        new Promise<{ aborted: boolean }>((res) => { resolveJoin = () => res({ aborted: false }); }),
      );
      const callOrder: string[] = [];
      mockRemoveStream.mockImplementation(() => { callOrder.push('removeStream'); });
      const onStreamComplete = vi.fn(() => { callOrder.push('onStreamComplete'); });

      renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete }));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      await act(async () => { resolveJoin(); });

      expect(callOrder).toEqual(['onStreamComplete', 'removeStream']);
    });
  });

  describe('SSE join error', () => {
    it('given consumeStreamJoin rejects, should call removeStream to prevent stale store entry', async () => {
      mockConsumeStreamJoin.mockRejectedValue(new Error('network error'));

      renderHook(() => useChannelStreamSocket('page-a'));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      await act(async () => { await Promise.resolve(); });

      expect(mockRemoveStream).toHaveBeenCalledWith('msg-1');
    });
  });

  describe('chat:stream_start from local browser session', () => {
    it('given triggeredBy.browserSessionId matches getBrowserSessionId(), should skip addStream and consumeStreamJoin', () => {
      const localPayload: AiStreamStartPayload = {
        ...START_PAYLOAD,
        triggeredBy: { userId: 'user-1', displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
      };

      renderHook(() => useChannelStreamSocket('page-a'));
      act(() => { mockSocket._trigger('chat:stream_start', localPayload); });

      expect(mockAddStream).not.toHaveBeenCalled();
      expect(mockConsumeStreamJoin).not.toHaveBeenCalled();
    });

    it('given triggeredBy.userId matches local user but browserSessionId differs, should still addStream (cross-session same-user)', () => {
      const otherSessionSameUser: AiStreamStartPayload = {
        ...START_PAYLOAD,
        triggeredBy: { userId: 'user-1', displayName: 'Me', browserSessionId: SESSION_ID_REMOTE },
      };

      renderHook(() => useChannelStreamSocket('page-a'));
      act(() => { mockSocket._trigger('chat:stream_start', otherSessionSameUser); });

      expect(mockAddStream).toHaveBeenCalledWith(expect.objectContaining({
        messageId: 'msg-1',
        isOwn: false,
      }));
    });
  });

  // A1 — pageId guard
  describe('pageId guard', () => {
    it('given chat:stream_start with a different pageId, should ignore the event', () => {
      renderHook(() => useChannelStreamSocket('page-a'));

      act(() => {
        mockSocket._trigger('chat:stream_start', { ...START_PAYLOAD, pageId: 'page-b' });
      });

      expect(mockAddStream).not.toHaveBeenCalled();
      expect(mockConsumeStreamJoin).not.toHaveBeenCalled();
    });

    it('given chat:stream_complete with a different pageId, should ignore the event', () => {
      const onStreamComplete = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete }));

      act(() => {
        mockSocket._trigger('chat:stream_complete', { ...COMPLETE_PAYLOAD, pageId: 'page-b' });
      });

      expect(mockRemoveStream).not.toHaveBeenCalled();
      expect(onStreamComplete).not.toHaveBeenCalled();
    });
  });

  describe('chat:stream_complete', () => {
    it('should call removeStream and onStreamComplete', () => {
      const onStreamComplete = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete }));

      act(() => { mockSocket._trigger('chat:stream_complete', COMPLETE_PAYLOAD); });

      expect(mockRemoveStream).toHaveBeenCalledWith('msg-1');
      expect(onStreamComplete).toHaveBeenCalledWith('msg-1');
    });

    it('should call onStreamComplete before removeStream so stream data is available in the callback (socket path)', () => {
      const callOrder: string[] = [];
      mockRemoveStream.mockImplementation(() => { callOrder.push('removeStream'); });
      const onStreamComplete = vi.fn(() => { callOrder.push('onStreamComplete'); });

      renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete }));

      act(() => { mockSocket._trigger('chat:stream_complete', COMPLETE_PAYLOAD); });

      expect(callOrder).toEqual(['onStreamComplete', 'removeStream']);
    });

    it('should abort the in-flight controller if one exists', async () => {
      let capturedSignal!: AbortSignal;
      mockConsumeStreamJoin.mockImplementation(
        (_id: string, signal: AbortSignal) => {
          capturedSignal = signal;
          return new Promise(() => {}); // never resolves
        },
      );

      renderHook(() => useChannelStreamSocket('page-a'));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });
      act(() => { mockSocket._trigger('chat:stream_complete', COMPLETE_PAYLOAD); });

      expect(capturedSignal.aborted).toBe(true);
    });
  });

  // A2 — double onStreamComplete prevention
  describe('onStreamComplete deduplication', () => {
    it('given SSE done sentinel resolves and chat:stream_complete also fires, should call onStreamComplete exactly once', async () => {
      let resolveJoin!: () => void;
      mockConsumeStreamJoin.mockReturnValue(
        new Promise<{ aborted: boolean }>((res) => { resolveJoin = () => res({ aborted: false }); }),
      );
      const onStreamComplete = vi.fn();

      renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete }));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      // SSE done resolves first
      await act(async () => { resolveJoin(); });

      // Then socket stream_complete also fires
      act(() => { mockSocket._trigger('chat:stream_complete', COMPLETE_PAYLOAD); });

      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });

    it('given chat:stream_complete fires before SSE resolves, should call onStreamComplete exactly once', async () => {
      mockConsumeStreamJoin.mockReturnValue(new Promise(() => {})); // never resolves naturally
      const onStreamComplete = vi.fn();

      renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete }));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      // stream_complete fires (aborts the SSE join)
      act(() => { mockSocket._trigger('chat:stream_complete', COMPLETE_PAYLOAD); });

      // Give any pending promise chains a tick to settle
      await act(async () => { await Promise.resolve(); });

      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });
  });

  // A3 — callback ref: onStreamComplete change should not re-register handlers
  describe('onStreamComplete stability', () => {
    it('given onStreamComplete reference changes between renders, should not re-register socket handlers', () => {
      let callback = vi.fn();
      const { rerender } = renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete: callback }));

      const onCallCount = mockSocket.on.mock.calls.length;

      callback = vi.fn(); // new reference
      rerender();

      expect(mockSocket.on.mock.calls.length).toBe(onCallCount);
    });

    it('given onStreamComplete reference changes between renders, should invoke the latest callback', async () => {
      let resolveJoin!: () => void;
      mockConsumeStreamJoin.mockReturnValue(
        new Promise<{ aborted: boolean }>((res) => { resolveJoin = () => res({ aborted: false }); }),
      );

      const firstCallback = vi.fn();
      let callback = firstCallback;
      const { rerender } = renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete: callback }));

      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      // Swap callback before stream resolves
      const secondCallback = vi.fn();
      callback = secondCallback;
      rerender();

      await act(async () => { resolveJoin(); });

      expect(firstCallback).not.toHaveBeenCalled();
      expect(secondCallback).toHaveBeenCalledWith('msg-1');
    });
  });

  describe('cleanup on unmount', () => {
    it('should remove socket listeners, abort controllers, and clearPageStreams', () => {
      const { unmount } = renderHook(() => useChannelStreamSocket('page-a'));

      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      let capturedSignal!: AbortSignal;
      const lastCall = mockConsumeStreamJoin.mock.calls.at(-1);
      if (lastCall) capturedSignal = lastCall[1] as AbortSignal;

      unmount();

      if (capturedSignal) expect(capturedSignal.aborted).toBe(true);
      expect(mockClearPageStreams).toHaveBeenCalledWith('page-a');
      expect(mockSocket.off).toHaveBeenCalledWith('chat:stream_start', expect.any(Function));
      expect(mockSocket.off).toHaveBeenCalledWith('chat:stream_complete', expect.any(Function));
    });
  });

  // AC5 — DB bootstrap on mount
  describe('DB bootstrap on mount', () => {
    it('given the hook mounts, should fetch active streams for the channelId', async () => {
      renderHook(() => useChannelStreamSocket('page-a'));

      await act(async () => { await Promise.resolve(); });

      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        '/api/ai/chat/active-streams?channelId=page-a',
        expect.objectContaining({ credentials: 'include' }),
      );
    });

    it('given the channelId contains characters needing encoding, should encode it in the URL', async () => {
      renderHook(() => useChannelStreamSocket('user:abc:global'));

      await act(async () => { await Promise.resolve(); });

      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        '/api/ai/chat/active-streams?channelId=user%3Aabc%3Aglobal',
        expect.objectContaining({ credentials: 'include' }),
      );
    });

    it('given a remote-tab stream is active in the DB, should addStream with isOwn=false and start consumeStreamJoin', async () => {
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-bootstrap',
            conversationId: 'conv-1',
            triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
          }],
        }),
      });

      renderHook(() => useChannelStreamSocket('page-a'));

      await act(async () => { await Promise.resolve(); });

      expect(mockAddStream).toHaveBeenCalledWith({
        messageId: 'msg-bootstrap',
        pageId: 'page-a',
        conversationId: 'conv-1',
        triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
        isOwn: false,
      });
      expect(mockConsumeStreamJoin).toHaveBeenCalledWith(
        'msg-bootstrap',
        expect.any(AbortSignal),
        expect.any(Function),
      );
    });

    it('given a stream from the current tab is active in the DB, should addStream with isOwn=true', async () => {
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-own',
            conversationId: 'conv-1',
            triggeredBy: { userId: 'user-1', displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
          }],
        }),
      });

      renderHook(() => useChannelStreamSocket('page-a'));

      await act(async () => { await Promise.resolve(); });

      expect(mockAddStream).toHaveBeenCalledWith(expect.objectContaining({
        messageId: 'msg-own',
        isOwn: true,
      }));
    });

    it('given a stream is already in processedRef (completed via socket race), should not re-add', async () => {
      mockFetchWithAuth.mockImplementationOnce(async () => {
        await Promise.resolve();
        return {
          ok: true,
          json: async () => ({
            streams: [{
              messageId: 'msg-1',
              conversationId: 'conv-1',
              triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
            }],
          }),
        };
      });

      const onStreamComplete = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete }));

      // Fire stream_complete BEFORE the bootstrap fetch resolves —
      // this populates processedRef, so the bootstrap should skip msg-1.
      act(() => { mockSocket._trigger('chat:stream_complete', COMPLETE_PAYLOAD); });

      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(mockAddStream).not.toHaveBeenCalled();
    });

    it('given the bootstrap fetch fails, should warn and not throw', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockFetchWithAuth.mockRejectedValueOnce(new Error('network down'));

      renderHook(() => useChannelStreamSocket('page-a'));

      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(warn).toHaveBeenCalledWith(
        '[useChannelStreamSocket] bootstrap failed',
        expect.any(Error),
      );
      warn.mockRestore();
    });
  });

  // AC6 — bootstrap unmount safety
  describe('bootstrap unmount safety', () => {
    it('given fetch resolves after unmount, should not call addStream', async () => {
      let resolveFetch!: (value: unknown) => void;
      mockFetchWithAuth.mockImplementationOnce(
        () => new Promise((res) => { resolveFetch = res; }),
      );

      const { unmount } = renderHook(() => useChannelStreamSocket('page-a'));
      unmount();

      await act(async () => {
        resolveFetch({
          ok: true,
          json: async () => ({
            streams: [{
              messageId: 'msg-late',
              conversationId: 'conv-1',
              triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
            }],
          }),
        });
        await Promise.resolve();
      });

      expect(mockAddStream).not.toHaveBeenCalled();
      expect(mockConsumeStreamJoin).not.toHaveBeenCalled();
    });

    it('given a bootstrap controller is in flight, should abort it on unmount', async () => {
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-bootstrap',
            conversationId: 'conv-1',
            triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
          }],
        }),
      });
      mockConsumeStreamJoin.mockReturnValue(new Promise(() => {})); // never resolves

      const { unmount } = renderHook(() => useChannelStreamSocket('page-a'));

      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      let capturedSignal!: AbortSignal;
      const lastCall = mockConsumeStreamJoin.mock.calls.at(-1);
      if (lastCall) capturedSignal = lastCall[1] as AbortSignal;

      unmount();

      expect(capturedSignal.aborted).toBe(true);
    });
  });

  describe('onOwnStreamBootstrap', () => {
    it('given a bootstrapped stream from the local browser session, should fire onOwnStreamBootstrap exactly once with the messageId', async () => {
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-own-bootstrap',
            conversationId: 'conv-1',
            triggeredBy: { userId: 'user-1', displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
          }],
        }),
      });
      const onOwnStreamBootstrap = vi.fn();

      renderHook(() => useChannelStreamSocket('page-a', { onOwnStreamBootstrap }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(onOwnStreamBootstrap).toHaveBeenCalledTimes(1);
      expect(onOwnStreamBootstrap).toHaveBeenCalledWith({ messageId: 'msg-own-bootstrap' });
    });

    it('given a bootstrapped stream from a remote tab, should not fire onOwnStreamBootstrap', async () => {
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-remote-bootstrap',
            conversationId: 'conv-1',
            triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
          }],
        }),
      });
      const onOwnStreamBootstrap = vi.fn();

      renderHook(() => useChannelStreamSocket('page-a', { onOwnStreamBootstrap }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(onOwnStreamBootstrap).not.toHaveBeenCalled();
    });

    it('given a chat:stream_start fires after mount, should not fire onOwnStreamBootstrap', () => {
      const onOwnStreamBootstrap = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onOwnStreamBootstrap }));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      expect(onOwnStreamBootstrap).not.toHaveBeenCalled();
    });
  });

  describe('onOwnStreamFinalize', () => {
    const bootstrapOwnStream = (messageId = 'msg-own') => {
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId,
            conversationId: 'conv-1',
            triggeredBy: { userId: 'user-1', displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
          }],
        }),
      });
    };

    it('given a bootstrapped own stream completes via SSE resolve, should fire onOwnStreamFinalize exactly once', async () => {
      bootstrapOwnStream();
      let resolveJoin!: () => void;
      mockConsumeStreamJoin.mockReturnValue(
        new Promise<{ aborted: boolean }>((res) => { resolveJoin = () => res({ aborted: false }); }),
      );
      const onOwnStreamFinalize = vi.fn();

      renderHook(() => useChannelStreamSocket('page-a', { onOwnStreamFinalize }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      await act(async () => { resolveJoin(); });

      expect(onOwnStreamFinalize).toHaveBeenCalledTimes(1);
      expect(onOwnStreamFinalize).toHaveBeenCalledWith({ messageId: 'msg-own' });
    });

    it('given a bootstrapped own stream is finalized via chat:stream_complete socket, should fire onOwnStreamFinalize exactly once', async () => {
      bootstrapOwnStream();
      mockConsumeStreamJoin.mockReturnValue(new Promise(() => {})); // never resolves
      const onOwnStreamFinalize = vi.fn();

      renderHook(() => useChannelStreamSocket('page-a', { onOwnStreamFinalize }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      act(() => {
        mockSocket._trigger('chat:stream_complete', { messageId: 'msg-own', pageId: 'page-a' });
      });
      await act(async () => { await Promise.resolve(); });

      expect(onOwnStreamFinalize).toHaveBeenCalledTimes(1);
      expect(onOwnStreamFinalize).toHaveBeenCalledWith({ messageId: 'msg-own' });
    });

    it('given both SSE resolve and chat:stream_complete fire for the same own stream, should fire onOwnStreamFinalize exactly once', async () => {
      bootstrapOwnStream();
      let resolveJoin!: () => void;
      mockConsumeStreamJoin.mockReturnValue(
        new Promise<{ aborted: boolean }>((res) => { resolveJoin = () => res({ aborted: false }); }),
      );
      const onOwnStreamFinalize = vi.fn();

      renderHook(() => useChannelStreamSocket('page-a', { onOwnStreamFinalize }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      await act(async () => { resolveJoin(); });
      act(() => {
        mockSocket._trigger('chat:stream_complete', { messageId: 'msg-own', pageId: 'page-a' });
      });

      expect(onOwnStreamFinalize).toHaveBeenCalledTimes(1);
    });

    it('given a remote stream completes, should not fire onOwnStreamFinalize', async () => {
      const onOwnStreamFinalize = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onOwnStreamFinalize }));

      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });
      act(() => { mockSocket._trigger('chat:stream_complete', COMPLETE_PAYLOAD); });

      expect(onOwnStreamFinalize).not.toHaveBeenCalled();
    });

    it('given the hook unmounts while an own stream is in flight, should not fire onOwnStreamFinalize', async () => {
      bootstrapOwnStream();
      mockConsumeStreamJoin.mockReturnValue(new Promise(() => {}));
      const onOwnStreamFinalize = vi.fn();

      const { unmount } = renderHook(() => useChannelStreamSocket('page-a', { onOwnStreamFinalize }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      unmount();
      await act(async () => { await Promise.resolve(); });

      expect(onOwnStreamFinalize).not.toHaveBeenCalled();
    });
  });
});
