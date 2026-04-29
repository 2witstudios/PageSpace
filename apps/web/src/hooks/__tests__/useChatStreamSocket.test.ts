import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------
const {
  mockSocket,
  mockAddStream,
  mockAppendText,
  mockRemoveStream,
  mockClearPageStreams,
  mockConsumeStreamJoin,
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
      handlers[event]?.forEach((h) => h(payload));
    },
  };

  const mockAddStream = vi.fn();
  const mockAppendText = vi.fn();
  const mockRemoveStream = vi.fn();
  const mockClearPageStreams = vi.fn();
  const mockConsumeStreamJoin = vi.fn().mockResolvedValue({ aborted: false });

  return {
    mockSocket,
    mockAddStream,
    mockAppendText,
    mockRemoveStream,
    mockClearPageStreams,
    mockConsumeStreamJoin,
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

import { useChatStreamSocket } from '../useChatStreamSocket';
import type { AiStreamStartPayload, AiStreamCompletePayload } from '@/lib/websocket/socket-utils';

const START_PAYLOAD: AiStreamStartPayload = {
  messageId: 'msg-1',
  pageId: 'page-a',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'user-2', displayName: 'Alice' },
};

const COMPLETE_PAYLOAD: AiStreamCompletePayload = {
  messageId: 'msg-1',
  pageId: 'page-a',
};

describe('useChatStreamSocket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConsumeStreamJoin.mockResolvedValue({ aborted: false });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('chat:stream_start from another user', () => {
    it('should call addStream and start consumeStreamJoin', () => {
      renderHook(() => useChatStreamSocket('page-a', 'user-1'));

      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      expect(mockAddStream).toHaveBeenCalledWith({
        messageId: 'msg-1',
        pageId: 'page-a',
        conversationId: 'conv-1',
        triggeredBy: { userId: 'user-2', displayName: 'Alice' },
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

      renderHook(() => useChatStreamSocket('page-a', 'user-1'));
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

      renderHook(() => useChatStreamSocket('page-a', 'user-1', onStreamComplete));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      await act(async () => { resolveJoin(); });

      expect(mockRemoveStream).toHaveBeenCalledWith('msg-1');
      expect(onStreamComplete).toHaveBeenCalledWith('msg-1');
    });
  });

  describe('chat:stream_start from local user', () => {
    it('should skip addStream and consumeStreamJoin when triggeredBy.userId matches currentUserId', () => {
      const localPayload: AiStreamStartPayload = {
        ...START_PAYLOAD,
        triggeredBy: { userId: 'user-1', displayName: 'Me' },
      };

      renderHook(() => useChatStreamSocket('page-a', 'user-1'));
      act(() => { mockSocket._trigger('chat:stream_start', localPayload); });

      expect(mockAddStream).not.toHaveBeenCalled();
      expect(mockConsumeStreamJoin).not.toHaveBeenCalled();
    });
  });

  describe('chat:stream_complete', () => {
    it('should call removeStream and onStreamComplete', () => {
      const onStreamComplete = vi.fn();
      renderHook(() => useChatStreamSocket('page-a', 'user-1', onStreamComplete));

      act(() => { mockSocket._trigger('chat:stream_complete', COMPLETE_PAYLOAD); });

      expect(mockRemoveStream).toHaveBeenCalledWith('msg-1');
      expect(onStreamComplete).toHaveBeenCalledWith('msg-1');
    });

    it('should abort the in-flight controller if one exists', async () => {
      let capturedSignal!: AbortSignal;
      mockConsumeStreamJoin.mockImplementation(
        (_id: string, signal: AbortSignal) => {
          capturedSignal = signal;
          return new Promise(() => {}); // never resolves
        },
      );

      renderHook(() => useChatStreamSocket('page-a', 'user-1'));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });
      act(() => { mockSocket._trigger('chat:stream_complete', COMPLETE_PAYLOAD); });

      expect(capturedSignal.aborted).toBe(true);
    });
  });

  describe('cleanup on unmount', () => {
    it('should remove socket listeners, abort controllers, and clearPageStreams', () => {
      const { unmount } = renderHook(() => useChatStreamSocket('page-a', 'user-1'));

      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      let capturedSignal!: AbortSignal;
      // Re-check: consumeStreamJoin was called, signal captured from last call
      const lastCall = mockConsumeStreamJoin.mock.calls.at(-1);
      if (lastCall) capturedSignal = lastCall[1] as AbortSignal;

      unmount();

      if (capturedSignal) expect(capturedSignal.aborted).toBe(true);
      expect(mockClearPageStreams).toHaveBeenCalledWith('page-a');
      expect(mockSocket.off).toHaveBeenCalledWith('chat:stream_start', expect.any(Function));
      expect(mockSocket.off).toHaveBeenCalledWith('chat:stream_complete', expect.any(Function));
    });
  });
});
