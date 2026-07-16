import type { UIMessage } from 'ai';
import { applyMessageEdit } from '@/lib/ai/streams/applyMessageEdit';
import { applyMessageDelete } from '@/lib/ai/streams/applyMessageDelete';
import type { PendingMutation } from './seedEmpty';

/**
 * Replays live mutations recorded during a load's flight onto that load's
 * snapshot, in the order they happened. Reuses `applyMessageEdit`/
 * `applyMessageDelete`. Returns the input `messages` reference unchanged
 * when `pending` is empty.
 *
 * `remoteMessage` (genuine new user message, content never changes) replays as
 * append-if-absent. `confirmedMessage` (an assistant reply confirmation, whose
 * content CAN legitimately supersede a load snapshot's stale/partial copy of
 * the same id) replays as upsert-by-id instead — see `applyConfirmedMessage`.
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
    if (mutation.type === 'confirmedMessage') {
      const index = acc.findIndex((m) => m.id === mutation.message.id);
      return index === -1
        ? [...acc, mutation.message]
        : acc.map((m, i) => (i === index ? mutation.message : m));
    }
    if (mutation.type === 'edit') {
      return applyMessageEdit(acc, mutation.payload);
    }
    return applyMessageDelete(acc, mutation.messageId);
  }, messages);
};
