import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rollbackOptimisticSendOnFailure } from '../rollbackOptimisticSendOnFailure';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';

describe('rollbackOptimisticSendOnFailure', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('given the thunk throws SYNCHRONOUSLY, should roll back the optimistic send and re-throw', () => {
    const rollbackSpy = vi.spyOn(conversationMessagesActions, 'removeOptimisticSendOnFailure').mockImplementation(() => {});
    const thunk = () => {
      throw new Error('sync boom');
    };

    expect(() => rollbackOptimisticSendOnFailure(thunk, 'conv-1', 'msg-1')).toThrow('sync boom');
    expect(rollbackSpy).toHaveBeenCalledWith('conv-1', 'msg-1');
  });

  it('given the thunk returns a promise that rejects, should roll back the optimistic send', async () => {
    const rollbackSpy = vi.spyOn(conversationMessagesActions, 'removeOptimisticSendOnFailure').mockImplementation(() => {});
    const thunk = () => Promise.reject(new Error('async boom'));

    rollbackOptimisticSendOnFailure(thunk, 'conv-1', 'msg-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(rollbackSpy).toHaveBeenCalledWith('conv-1', 'msg-1');
  });

  it('given the thunk returns a promise that resolves, should NOT roll back', async () => {
    const rollbackSpy = vi.spyOn(conversationMessagesActions, 'removeOptimisticSendOnFailure').mockImplementation(() => {});
    const thunk = () => Promise.resolve('ok');

    rollbackOptimisticSendOnFailure(thunk, 'conv-1', 'msg-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(rollbackSpy).not.toHaveBeenCalled();
  });

  it('given the thunk returns a non-thenable value (e.g. wrapSend dropped the request, returned undefined), should NOT roll back and should return the value', () => {
    const rollbackSpy = vi.spyOn(conversationMessagesActions, 'removeOptimisticSendOnFailure').mockImplementation(() => {});
    const thunk = () => undefined;

    const result = rollbackOptimisticSendOnFailure(thunk, 'conv-1', 'msg-1');

    expect(result).toBeUndefined();
    expect(rollbackSpy).not.toHaveBeenCalled();
  });

  // The bug this fixes: previously this helper took a PRECOMPUTED result
  // (`wrapSend(...)` evaluated as a plain argument). wrapSend's own send call can throw
  // synchronously — its internal try/catch handles its own concerns then re-throws — and
  // that throw propagated out of the whole call expression before the helper's body ever
  // ran, leaving the optimistic bubble stuck in the cache forever (PR 6 review,
  // CodeRabbit). Taking a thunk and invoking it inside this function's own try/catch
  // closes that gap — this test simulates exactly that: wrapSend-shaped rethrow.
  it('given a wrapSend-shaped thunk that settles pendingSend then re-throws (its real behavior on a synchronous sendFn throw), should still roll back the optimistic send', () => {
    const rollbackSpy = vi.spyOn(conversationMessagesActions, 'removeOptimisticSendOnFailure').mockImplementation(() => {});
    const settleOnFailure = vi.fn();
    const wrapSendShaped = (sendFn: () => unknown) => {
      try {
        return sendFn();
      } catch (error) {
        settleOnFailure(error);
        throw error;
      }
    };
    const sendFn = () => {
      throw new Error('credit gate rejected synchronously');
    };

    expect(() =>
      rollbackOptimisticSendOnFailure(() => wrapSendShaped(sendFn), 'conv-1', 'msg-1'),
    ).toThrow('credit gate rejected synchronously');

    expect(settleOnFailure).toHaveBeenCalledTimes(1);
    expect(rollbackSpy).toHaveBeenCalledWith('conv-1', 'msg-1');
  });
});
