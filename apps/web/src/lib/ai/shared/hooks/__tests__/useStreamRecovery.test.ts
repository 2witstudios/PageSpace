import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useStreamRecovery } from '../useStreamRecovery';

describe('useStreamRecovery', () => {
  let clearError: ReturnType<typeof vi.fn>;
  let handleRetry: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    clearError = vi.fn();
    handleRetry = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('given no error, should not retry', () => {
    renderHook(() =>
      useStreamRecovery({
        error: undefined,
        status: 'ready',
        clearError,
        handleRetry,
      })
    );

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(handleRetry).not.toHaveBeenCalled();
  });

  it('given a network error, should auto-retry after delay', async () => {
    const networkError = new Error('Failed to fetch');

    renderHook(() =>
      useStreamRecovery({
        error: networkError,
        status: 'error',
        clearError,
        handleRetry,
      })
    );

    // First retry at 1s delay (1000 * 2^0)
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(clearError).toHaveBeenCalledTimes(1);
    expect(handleRetry).toHaveBeenCalledTimes(1);
  });

  it('given a TypeError (fetch network failure), should auto-retry', async () => {
    const typeError = new TypeError('network error');

    renderHook(() =>
      useStreamRecovery({
        error: typeError,
        status: 'error',
        clearError,
        handleRetry,
      })
    );

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(handleRetry).toHaveBeenCalledTimes(1);
  });

  it('given an API error (401 unauthorized), should NOT auto-retry', () => {
    const apiError = new Error('401 Unauthorized');

    renderHook(() =>
      useStreamRecovery({
        error: apiError,
        status: 'error',
        clearError,
        handleRetry,
      })
    );

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(handleRetry).not.toHaveBeenCalled();
  });

  it('given a 429 rate limit error, should NOT auto-retry', () => {
    const rateLimitError = new Error('429 rate limit exceeded');

    renderHook(() =>
      useStreamRecovery({
        error: rateLimitError,
        status: 'error',
        clearError,
        handleRetry,
      })
    );

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(handleRetry).not.toHaveBeenCalled();
  });

  it('given a 403 error, should NOT auto-retry', () => {
    const forbiddenError = new Error('403 Forbidden');

    renderHook(() =>
      useStreamRecovery({
        error: forbiddenError,
        status: 'error',
        clearError,
        handleRetry,
      })
    );

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(handleRetry).not.toHaveBeenCalled();
  });

  it('given "chatId is required" error, should NOT auto-retry', () => {
    const chatIdError = new Error('chatId is required');

    renderHook(() =>
      useStreamRecovery({
        error: chatIdError,
        status: 'error',
        clearError,
        handleRetry,
      })
    );

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(handleRetry).not.toHaveBeenCalled();
  });

  it('given an unknown error (not network, not API), should NOT auto-retry', () => {
    const unknownError = new Error('some random error');

    renderHook(() =>
      useStreamRecovery({
        error: unknownError,
        status: 'error',
        clearError,
        handleRetry,
      })
    );

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(handleRetry).not.toHaveBeenCalled();
  });

  it('given max retries exceeded, should stop retrying', async () => {
    const networkError = new Error('connection timeout');

    const { rerender } = renderHook(
      (props: { error: Error | undefined; status: 'ready' | 'submitted' | 'streaming' | 'error' }) =>
        useStreamRecovery({
          error: props.error,
          status: props.status,
          clearError,
          handleRetry,
          maxRetries: 2,
        }),
      { initialProps: { error: networkError as Error | undefined, status: 'error' as const } }
    );

    // First retry at 1s
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(handleRetry).toHaveBeenCalledTimes(1);

    // Simulate error still present after retry (re-render with same error)
    handleRetry.mockClear();
    clearError.mockClear();

    // Need to re-trigger the effect with a "new" error reference
    const newError = new Error('connection timeout');
    rerender({ error: newError, status: 'error' });

    // Second retry at 2s (1000 * 2^1)
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(handleRetry).toHaveBeenCalledTimes(1);

    // Third attempt should NOT happen (max 2)
    handleRetry.mockClear();
    const thirdError = new Error('connection timeout');
    rerender({ error: thirdError, status: 'error' });

    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(handleRetry).not.toHaveBeenCalled();
  });

  it('given a successful stream completes, should reset retry count', async () => {
    const networkError = new Error('network error');

    const { rerender } = renderHook(
      (props: { error: Error | undefined; status: 'ready' | 'submitted' | 'streaming' | 'error' }) =>
        useStreamRecovery({
          error: props.error,
          status: props.status,
          clearError,
          handleRetry,
          maxRetries: 2,
        }),
      { initialProps: { error: networkError as Error | undefined, status: 'error' as const } }
    );

    // First retry
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(handleRetry).toHaveBeenCalledTimes(1);

    // Simulate successful stream: submitted -> streaming -> ready
    rerender({ error: undefined, status: 'streaming' });
    rerender({ error: undefined, status: 'ready' });

    // Now new error should retry from count 0
    handleRetry.mockClear();
    clearError.mockClear();
    const newError = new Error('network error');
    rerender({ error: newError, status: 'error' });

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(handleRetry).toHaveBeenCalledTimes(1);
  });

  it('should expose retryCount and retriesExhausted', () => {
    const { result } = renderHook(() =>
      useStreamRecovery({
        error: undefined,
        status: 'ready',
        clearError,
        handleRetry,
        maxRetries: 2,
      })
    );

    expect(result.current.retryCount).toBe(0);
    expect(result.current.retriesExhausted).toBe(false);
  });

  it('given status is not error, should not retry even with error present', () => {
    const networkError = new Error('network error');

    renderHook(() =>
      useStreamRecovery({
        error: networkError,
        status: 'streaming', // Not 'error'
        clearError,
        handleRetry,
      })
    );

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(handleRetry).not.toHaveBeenCalled();
  });

  it('given unmount during timeout, should clean up timeout', async () => {
    const networkError = new Error('network timeout');

    const { unmount } = renderHook(() =>
      useStreamRecovery({
        error: networkError,
        status: 'error',
        clearError,
        handleRetry,
      })
    );

    // Unmount before timeout fires
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    // handleRetry should not have been called since we unmounted
    expect(handleRetry).not.toHaveBeenCalled();
  });
});
