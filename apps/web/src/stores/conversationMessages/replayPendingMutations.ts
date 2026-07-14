import type { UIMessage } from 'ai';
import { applyMessageEdit } from '@/lib/ai/streams/applyMessageEdit';
import { applyMessageDelete } from '@/lib/ai/streams/applyMessageDelete';
import type { PendingMutation } from './seedEmpty';

/**
 * Replays live mutations recorded during a load's flight onto that load's
 * snapshot, in the order they happened. Reuses `applyMessageEdit`/
 * `applyMessageDelete`. Returns the input `messages` reference unchanged
 * when `pending` is empty.
 */
export const replayPendingMutations = (
  messages: UIMessage[],
  pending: readonly PendingMutation[],
): UIMessage[] => {
  if (pending.length === 0) return messages;

  return pending.reduce((acc, mutation) => {
    if (mutation.type === 'remoteMessage') {
      return acc.some((m) => m.id === mutation.message.id) ? acc : [...acc, mutation.message];
    }
    if (mutation.type === 'edit') {
      return applyMessageEdit(acc, mutation.payload);
    }
    return applyMessageDelete(acc, mutation.messageId);
  }, messages);
};
