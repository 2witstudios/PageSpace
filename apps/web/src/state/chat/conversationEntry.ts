import type { Entity } from '@adobe/data/ecs';
import type { ConversationCacheEntry, ConversationMessagesById } from '@/stores/conversationMessages/seedEmpty';
import type { ChatDataRead, ChatDataTransaction } from './chat-data-plugin';

/**
 * SPIKE (@adobe/data adoption evidence). Column ⇄ `ConversationCacheEntry`
 * projection for the Conversation archetype.
 *
 * `?? <seed default>` per column is not defensive padding: an ECS entity may
 * legitimately lack a component, and the seed value is exactly what
 * `seedEmpty()` returns for it, so a partially-populated row reads as the
 * same entry the zustand store would have produced.
 */
export const readConversationEntry = (store: ChatDataRead, entity: Entity): ConversationCacheEntry => ({
  messages: store.get(entity, 'messages') ?? [],
  optimisticSends: store.get(entity, 'optimisticSends') ?? [],
  loadGeneration: store.get(entity, 'loadGeneration') ?? 0,
  pendingMutationsSinceLoad: store.get(entity, 'pendingMutationsSinceLoad') ?? [],
  loadStatus: store.get(entity, 'loadStatus') ?? 'idle',
  olderCursor: store.get(entity, 'olderCursor') ?? null,
  hasMoreOlder: store.get(entity, 'hasMoreOlder') ?? false,
  isLoadingOlder: store.get(entity, 'isLoadingOlder') ?? false,
});

/** All conversation entities, projected back into the store's `byConversationId` shape. */
export const readAllConversations = (store: ChatDataRead): ConversationMessagesById => {
  const byConversationId: ConversationMessagesById = {};
  for (const entity of store.select(['conversationId'])) {
    const conversationId = store.get(entity, 'conversationId');
    if (conversationId === undefined) continue;
    byConversationId[conversationId] = readConversationEntry(store, entity);
  }
  return byConversationId;
};

/**
 * THE container swap, in one function.
 *
 * Every `useConversationMessagesStore` action was `set(state => ({ byConversationId:
 * applyX(state.byConversationId, event) }))`. Here the same pure `applyX` runs
 * against a single-key projection of ONE conversation entity and its result is
 * written back as columns — the transition function is untouched, only the
 * container around it changed.
 *
 * The pure functions all return their input reference when a transition is a
 * no-op, so `after === before` is a precise "nothing changed" test and the
 * transaction records zero write operations (which keeps it out of the undo
 * stack and out of `db.derive` recomputes).
 */
export const transitionConversation = (
  store: ChatDataTransaction,
  conversationId: string,
  transition: (byConversationId: ConversationMessagesById) => ConversationMessagesById,
): void => {
  const entity = store.indexes.conversationById.get({ conversationId });
  const before: ConversationMessagesById =
    entity === null ? {} : { [conversationId]: readConversationEntry(store, entity) };

  const after = transition(before);
  if (after === before) return;

  const next = after[conversationId];
  if (next === undefined) return;

  if (entity === null) {
    store.archetypes.Conversation.insert({ conversationId, ...next });
    return;
  }
  store.update(entity, next);
};
