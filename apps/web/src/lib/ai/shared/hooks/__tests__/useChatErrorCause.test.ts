import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatErrorCause } from '../useChatErrorCause';
import { useChatErrorStore } from '@/stores/useChatErrorStore';

const causeError = (message: string, code = 'unknown') => {
  const error = new Error(message, {
    cause: { code, httpStatus: null, message, retryable: false },
  });
  return error;
};

describe('useChatErrorCause', () => {
  beforeEach(() => {
    useChatErrorStore.setState({ byConversationId: {} });
  });

  it('given a typed-cause error, should store it under originConversationId and surface it as cause', () => {
    const error = causeError('out of credits', 'out_of_credits');
    const { result } = renderHook(() =>
      useChatErrorCause('conv-1', error, vi.fn(), 'conv-1'),
    );

    expect(result.current.cause?.code).toBe('out_of_credits');
    expect(useChatErrorStore.getState().byConversationId['conv-1']?.code).toBe('out_of_credits');
  });

  it('given the error clears (retry succeeded), should clear the stored cause rather than leaving it stale', () => {
    const error = causeError('out of credits', 'out_of_credits');
    const initialProps: { error: Error | undefined } = { error };
    const { result, rerender } = renderHook(
      (props: { error: Error | undefined }) => useChatErrorCause('conv-1', props.error, vi.fn(), 'conv-1'),
      { initialProps },
    );

    expect(result.current.cause).not.toBeNull();

    rerender({ error: undefined });

    expect(result.current.cause).toBeNull();
    expect(useChatErrorStore.getState().byConversationId['conv-1']).toBeUndefined();
  });

  it('given a request sent against conversation A fails after the user switched to conversation B, should key the cause under A (originConversationId), not B (current conversationId)', () => {
    const error = causeError('server exploded');
    const { result, rerender } = renderHook(
      (props: { conversationId: string; originConversationId: string }) =>
        useChatErrorCause(props.conversationId, error, vi.fn(), props.originConversationId),
      { initialProps: { conversationId: 'conv-a', originConversationId: 'conv-a' } },
    );

    // User switches to conv-b WHILE conv-a's request is still in flight — conversationId
    // (current) moves, but originConversationId (where the send was actually issued) stays.
    rerender({ conversationId: 'conv-b', originConversationId: 'conv-a' });

    expect(useChatErrorStore.getState().byConversationId['conv-a']?.message).toBe('server exploded');
    expect(useChatErrorStore.getState().byConversationId['conv-b']).toBeUndefined();
    // Reading from conv-b (current) must not see conv-a's error.
    expect(result.current.cause).toBeNull();
  });

  it('given the same error object reference across renders, should not re-invoke setError (no redundant store writes)', () => {
    const error = causeError('same error');
    const { rerender } = renderHook(
      (props: { conversationId: string }) => useChatErrorCause(props.conversationId, error, vi.fn(), 'conv-1'),
      { initialProps: { conversationId: 'conv-1' } },
    );

    const setErrorSpy = vi.spyOn(useChatErrorStore.getState(), 'setError');
    rerender({ conversationId: 'conv-1' });

    expect(setErrorSpy).not.toHaveBeenCalled();
  });

  it('given dismiss is called, should clear the store entry for conversationId and call clearTransportError', () => {
    const error = causeError('dismiss me');
    const clearTransportError = vi.fn();
    const { result } = renderHook(() =>
      useChatErrorCause('conv-1', error, clearTransportError, 'conv-1'),
    );

    expect(result.current.cause).not.toBeNull();

    act(() => {
      result.current.dismiss();
    });

    expect(useChatErrorStore.getState().byConversationId['conv-1']).toBeUndefined();
    expect(clearTransportError).toHaveBeenCalledTimes(1);
  });

  it('given no error and no originConversationId, should not throw and cause stays null', () => {
    const { result } = renderHook(() => useChatErrorCause(null, undefined, vi.fn(), null));
    expect(result.current.cause).toBeNull();
  });
});
