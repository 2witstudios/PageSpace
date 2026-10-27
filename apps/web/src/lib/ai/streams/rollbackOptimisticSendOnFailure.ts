import { isThenable } from './isThenable';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';

/**
 * Attaches a rollback to a send's result (epic leaf 6.5, M9): if the send
 * rejects — e.g. a credit-gate 402 fires BEFORE the message is persisted —
 * the optimistic bubble is removed from the cache. A resolved or
 * synchronous (non-thenable) send is left untouched.
 *
 * Takes a THUNK, not a precomputed result: `wrapSend`'s own send call can
 * throw SYNCHRONOUSLY (its internal try/catch handles its own concerns —
 * clearing pendingSend, toasting — then re-throws). If the caller evaluated
 * `wrapSend(...)` as a plain argument, that throw would propagate out of the
 * whole call expression before this function's body ever ran, leaving the
 * optimistic bubble stuck in the cache forever. Invoking the thunk INSIDE
 * this function's own try/catch means a synchronous throw is caught here too
 * (PR 6 review, CodeRabbit) — the error is still re-thrown afterward, so
 * callers see the same propagation they always did.
 */
export const rollbackOptimisticSendOnFailure = <T>(
  sendThunk: () => T,
  conversationId: string,
  messageId: string,
): T => {
  try {
    const result = sendThunk();
    if (isThenable(result)) {
      Promise.resolve(result).catch(() => {
        conversationMessagesActions.removeOptimisticSendOnFailure(conversationId, messageId);
      });
    }
    return result;
  } catch (error) {
    conversationMessagesActions.removeOptimisticSendOnFailure(conversationId, messageId);
    throw error;
  }
};
