import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock external dependencies before imports
vi.mock('@/lib/ai/core/client', () => ({
  abortActiveStream: vi.fn(),
}));

import { useChatStop } from '../useChatStop';
import { abortActiveStream } from '@/lib/ai/core/client';

const mockAbortActiveStream = abortActiveStream as ReturnType<typeof vi.fn>;

describe('useChatStop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAbortActiveStream.mockResolvedValue(undefined);
  });

  it('given a chatId, should call abortActiveStream then chatStop', async () => {
    const chatStop = vi.fn();
    const { result } = renderHook(() => useChatStop('conv-123', chatStop));

    await act(async () => {
      await result.current();
    });

    expect(mockAbortActiveStream).toHaveBeenCalledWith({ chatId: 'conv-123' });
    expect(chatStop).toHaveBeenCalledTimes(1);
  });

  it('given null chatId, should skip abortActiveStream but still call chatStop', async () => {
    const chatStop = vi.fn();
    const { result } = renderHook(() => useChatStop(null, chatStop));

    await act(async () => {
      await result.current();
    });

    expect(mockAbortActiveStream).not.toHaveBeenCalled();
    expect(chatStop).toHaveBeenCalledTimes(1);
  });

  it('given abortActiveStream rejects, should still call chatStop via finally', async () => {
    mockAbortActiveStream.mockRejectedValue(new Error('abort failed'));
    const chatStop = vi.fn();
    const { result } = renderHook(() => useChatStop('conv-456', chatStop));

    // The hook's try/finally catches the rejection internally, so the returned
    // promise should resolve (the error is swallowed by the try block).
    // However, the async callback in useCallback has try { await abort() } finally { chatStop() }
    // which means the rejection propagates out of the callback. We need to catch it.
    await act(async () => {
      try {
        await result.current();
      } catch {
        // Expected: the rejection from abortActiveStream propagates
      }
    });

    expect(mockAbortActiveStream).toHaveBeenCalledWith({ chatId: 'conv-456' });
    expect(chatStop).toHaveBeenCalledTimes(1);
  });

  it('given re-render with same props, should return a stable function reference', () => {
    const chatStop = vi.fn();
    const { result, rerender } = renderHook(
      ({ chatId, stop }) => useChatStop(chatId, stop),
      { initialProps: { chatId: 'conv-1' as string | null, stop: chatStop } }
    );

    const firstRef = result.current;
    rerender({ chatId: 'conv-1', stop: chatStop });
    const secondRef = result.current;

    expect(firstRef).toBe(secondRef);
  });

  it('given chatId changes, should return a new function reference', () => {
    const chatStop = vi.fn();
    const { result, rerender } = renderHook(
      ({ chatId, stop }) => useChatStop(chatId, stop),
      { initialProps: { chatId: 'conv-1' as string | null, stop: chatStop } }
    );

    const firstRef = result.current;
    rerender({ chatId: 'conv-2', stop: chatStop });
    const secondRef = result.current;

    expect(firstRef).not.toBe(secondRef);
  });
});
