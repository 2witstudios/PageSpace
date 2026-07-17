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
    type Props = { conversationId: string; originConversationId: string; error: Error | undefined };
    const initialProps: Props = { conversationId: 'conv-a', originConversationId: 'conv-a', error: undefined };
    const { result, rerender } = renderHook(
      (props: Props) => useChatErrorCause(props.conversationId, props.error, vi.fn(), props.originConversationId),
      { initialProps },
    );

    // User switches to conv-b BEFORE conv-a's request actually fails — conversationId
    // (current) moves, but originConversationId (where the send was actually issued) stays.
    rerender({ conversationId: 'conv-b', originConversationId: 'conv-a', error: undefined });
    // NOW the late failure arrives — this is the real race: error and the conversation
    // switch land on different renders, not the same one.
    rerender({ conversationId: 'conv-b', originConversationId: 'conv-a', error });

    expect(useChatErrorStore.getState().byConversationId['conv-a']?.message).toBe('server exploded');
    expect(useChatErrorStore.getState().byConversationId['conv-b']).toBeUndefined();
    // Reading from conv-b (current) must not see conv-a's error.
    expect(result.current.cause).toBeNull();
  });

  // PR 6 review (CodeRabbit, Major): prevErrorRef must remember the ORIGIN an error was
  // recorded under, not just the error object — otherwise clearing after the fact clears
  // whatever conversation is CURRENT at clear-time, not the one the error actually belongs
  // to, permanently orphaning the real entry.
  it('given originConversationId changes to a NEW conversation while the SAME unresolved error is still pending, clearing that error should clear the ORIGINAL conversation, not the new current one', () => {
    const error = causeError('slow failure');
    type Props = { originConversationId: string; error: Error | undefined };
    const initialProps: Props = { originConversationId: 'conv-a', error };
    const { rerender } = renderHook(
      (props: Props) => useChatErrorCause('conv-a', props.error, vi.fn(), props.originConversationId),
      { initialProps },
    );
    expect(useChatErrorStore.getState().byConversationId['conv-a']?.message).toBe('slow failure');

    // A fresh send starts in a different conversation while the old error object is still
    // sitting unresolved on this same useChat instance.
    rerender({ originConversationId: 'conv-b', error });
    // The error now clears (superseded).
    rerender({ originConversationId: 'conv-b', error: undefined });

    // Must clear conv-a (where the error actually lived), not conv-b (which never had one).
    expect(useChatErrorStore.getState().byConversationId['conv-a']).toBeUndefined();
  });

  it('given an error first observed with originConversationId null, then re-observed (same object) once an origin becomes available, should still record it (not permanently skip it)', () => {
    const error = causeError('needs an origin');
    type Props = { originConversationId: string | null };
    const initialProps: Props = { originConversationId: null };
    const { rerender } = renderHook(
      (props: Props) => useChatErrorCause('conv-a', error, vi.fn(), props.originConversationId),
      { initialProps },
    );
    expect(useChatErrorStore.getState().byConversationId['conv-a']).toBeUndefined();

    rerender({ originConversationId: 'conv-a' });

    expect(useChatErrorStore.getState().byConversationId['conv-a']?.message).toBe('needs an origin');
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
