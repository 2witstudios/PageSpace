import { isThenable } from './isThenable';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';

/**
 * Attaches a rollback to a send's result (epic leaf 6.5, M9): if the send
 * rejects — e.g. a credit-gate 402 fires BEFORE the message is persisted —
 * the optimistic bubble is removed from the cache. A resolved or
 * synchronous (non-thenable) send is left untouched.
 */
export const rollbackOptimisticSendOnFailure = (
  sendResult: unknown,
  conversationId: string,
  messageId: string,
): void => {
  if (!isThenable(sendResult)) return;
  Promise.resolve(sendResult).catch(() => {
    conversationMessagesActions.removeOptimisticSendOnFailure(conversationId, messageId);
  });
};
