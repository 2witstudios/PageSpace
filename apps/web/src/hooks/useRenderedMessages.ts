import { useMemo } from 'react';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import type { ConversationCacheEntry } from '@/stores/conversationMessages/seedEmpty';
import { seedEmpty } from '@/stores/conversationMessages/seedEmpty';
import { selectRenderedMessages, type RenderedMessage } from '@/lib/ai/streams/selectRenderedMessages';
import { useActiveStream } from '@/hooks/useActiveStream';

// A single stable reference for "no cache entry yet" — `getEntry()` on the store
// allocates a fresh `seedEmpty()` (new array refs) on every call for an uncached
// conversation, which would make this hook's zustand selector look "changed" on
// every unrelated store update. Selecting straight off `byConversationId` against
// this one frozen constant keeps the pre-first-load window referentially stable.
const EMPTY_ENTRY: ConversationCacheEntry = seedEmpty();

/**
 * Facade — the sanctioned way for a component to read a conversation's
 * rendered message list (see PR 4 board: container-agnostic consumer rule).
 * Do not call `useConversationMessagesStore`/`usePendingStreamsStore` directly
 * from a component — this indirection is what lets the state container swap
 * (zustand → @adobe/data ECS, per the platform spike) stay a facade-internal
 * change instead of a consumer rewrite.
 */
export const useRenderedMessages = (
  pageId: string,
  conversationId: string | null,
): RenderedMessage[] => {
  const cacheEntry = useConversationMessagesStore((state) =>
    conversationId ? state.byConversationId[conversationId] ?? EMPTY_ENTRY : EMPTY_ENTRY,
  );
  const { streams } = useActiveStream(pageId, conversationId);

  return useMemo(() => selectRenderedMessages(cacheEntry, streams), [cacheEntry, streams]);
};
