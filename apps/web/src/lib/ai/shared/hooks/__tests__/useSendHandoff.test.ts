import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock external dependencies before imports
const mockStartPendingSend = vi.fn();
const mockEndPendingSend = vi.fn();

vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: {
    getState: () => ({
      startPendingSend: mockStartPendingSend,
      endPendingSend: mockEndPendingSend,
    }),
  },
}));

import { useSendHandoff } from '../useSendHandoff';

describe('useSendHandoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('given null conversationId, wrapSend should return undefined without calling sendFn', () => {
    const { result } = renderHook(() => useSendHandoff(null, 'ready'));

    let returnValue: unknown;
    act(() => {
      returnValue = result.current.wrapSend(() => 'result');
    });

    expect(returnValue).toBeUndefined();
    expect(mockStartPendingSend).not.toHaveBeenCalled();
  });

  it('given valid conversationId, wrapSend should call startPendingSend and return sendFn result', () => {
    const { result } = renderHook(() => useSendHandoff('conv-1', 'ready'));

    let returnValue: unknown;
    act(() => {
      returnValue = result.current.wrapSend(() => 'send-result');
    });

    expect(returnValue).toBe('send-result');
    expect(mockStartPendingSend).toHaveBeenCalledWith('conv-1');
  });

  it('given sendFn throws synchronously, should endPendingSend and re-throw', () => {
    const { result } = renderHook(() => useSendHandoff('conv-1', 'ready'));

    expect(() => {
      act(() => {
        result.current.wrapSend(() => {
          throw new Error('send error');
        });
      });
    }).toThrow('send error');

    expect(mockStartPendingSend).toHaveBeenCalledWith('conv-1');
    expect(mockEndPendingSend).toHaveBeenCalledWith('conv-1');
  });

  it('given status transitions to streaming after wrapSend, should endPendingSend', () => {
    const { result, rerender } = renderHook(
      ({ convId, status }: { convId: string | null; status: 'ready' | 'submitted' | 'streaming' | 'error' }) =>
        useSendHandoff(convId, status),
      { initialProps: { convId: 'conv-1', status: 'ready' as const } }
    );

    // Call wrapSend to mark pending
    act(() => {
      result.current.wrapSend(() => 'ok');
    });

    expect(mockStartPendingSend).toHaveBeenCalledWith('conv-1');
    mockEndPendingSend.mockClear();

    // Transition to submitted (streaming)
    rerender({ convId: 'conv-1', status: 'submitted' });

    expect(mockEndPendingSend).toHaveBeenCalledWith('conv-1');
  });

  it('given status transitions to error after wrapSend, should endPendingSend', () => {
    const { result, rerender } = renderHook(
      ({ convId, status }: { convId: string | null; status: 'ready' | 'submitted' | 'streaming' | 'error' }) =>
        useSendHandoff(convId, status),
      { initialProps: { convId: 'conv-1', status: 'ready' as const } }
    );

    act(() => {
      result.current.wrapSend(() => 'ok');
    });

    mockEndPendingSend.mockClear();

    // Transition to error
    rerender({ convId: 'conv-1', status: 'error' });

    expect(mockEndPendingSend).toHaveBeenCalledWith('conv-1');
  });

  it('given safety timeout expires (15s), should auto-clear orphaned pendingSend', () => {
    const { result } = renderHook(() => useSendHandoff('conv-1', 'ready'));

    act(() => {
      result.current.wrapSend(() => 'ok');
    });

    mockEndPendingSend.mockClear();

    // Advance time by 15 seconds
    act(() => {
      vi.advanceTimersByTime(15000);
    });

    expect(mockEndPendingSend).toHaveBeenCalledWith('conv-1');
  });

  it('given streaming starts before timeout, should not fire safety timeout', () => {
    const { result, rerender } = renderHook(
      ({ convId, status }: { convId: string | null; status: 'ready' | 'submitted' | 'streaming' | 'error' }) =>
        useSendHandoff(convId, status),
      { initialProps: { convId: 'conv-1', status: 'ready' as const } }
    );

    act(() => {
      result.current.wrapSend(() => 'ok');
    });

    // Streaming starts
    rerender({ convId: 'conv-1', status: 'submitted' });
    mockEndPendingSend.mockClear();

    // Advance past timeout
    act(() => {
      vi.advanceTimersByTime(20000);
    });

    // Should not have been called again (only the streaming handoff call)
    expect(mockEndPendingSend).not.toHaveBeenCalled();
  });

  it('given unmount, should clean up pendingSend and timeout', () => {
    const { result, unmount } = renderHook(() => useSendHandoff('conv-1', 'ready'));

    act(() => {
      result.current.wrapSend(() => 'ok');
    });

    mockEndPendingSend.mockClear();

    unmount();

    expect(mockEndPendingSend).toHaveBeenCalledWith('conv-1');
  });

  it('given no pending send on unmount, should not call endPendingSend', () => {
    const { unmount } = renderHook(() => useSendHandoff('conv-1', 'ready'));

    unmount();

    expect(mockEndPendingSend).not.toHaveBeenCalled();
  });

  it('given conversationId changes, should clean up previous pendingSend', () => {
    const { result, rerender } = renderHook(
      ({ convId, status }: { convId: string | null; status: 'ready' | 'submitted' | 'streaming' | 'error' }) =>
        useSendHandoff(convId, status),
      { initialProps: { convId: 'conv-1', status: 'ready' as const } }
    );

    act(() => {
      result.current.wrapSend(() => 'ok');
    });

    mockEndPendingSend.mockClear();

    // Change conversationId
    rerender({ convId: 'conv-2', status: 'ready' });

    // Cleanup effect for conv-1 should fire
    expect(mockEndPendingSend).toHaveBeenCalledWith('conv-1');
  });
});
