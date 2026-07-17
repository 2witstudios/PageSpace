import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import type { ConversationCacheEntry, ConversationLoadStatus } from '@/stores/conversationMessages/seedEmpty';
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

export interface ConversationLoadState {
  status: ConversationLoadStatus;
  /** True while a load for this conversation is in flight. */
  isLoading: boolean;
  /** True when the last settled load failed (messages, if any, are the prior snapshot). */
  hasError: boolean;
}

/**
 * Facade — a conversation's cache load state, for the loading/error UI that
 * used to live in per-surface local state (`isLoadingMessages`,
 * `globalMessagesLoadError`, `isConversationMessagesLoading`). Same
 * container-agnostic consumer rule as `useRenderedMessages`: components read
 * this, never the store's entry map.
 */
export const useConversationLoadState = (conversationId: string | null): ConversationLoadState =>
  useConversationMessagesStore(
    useShallow((state) => {
      const status: ConversationLoadStatus = conversationId
        ? state.byConversationId[conversationId]?.loadStatus ?? 'idle'
        : 'idle';
      return { status, isLoading: status === 'loading', hasError: status === 'error' };
    }),
  );

/**
 * Facade — a conversation's "load older" state (epic leaf 6.6), for wiring
 * ChatLayout/ChatMessagesArea's onScrollNearTop/isLoadingOlder props.
 *
 * Two scalar-returning selectors, not one `useShallow`-wrapped object selector:
 * the object form reproducibly triggered a `useSyncExternalStore` "Maximum update
 * depth exceeded" render loop in this store/React/zustand combination even though
 * the selected VALUES were stable across every call (confirmed by instrumenting
 * the selector — see PR 6 gate investigation). Scalars need no equality function
 * at all, sidestepping the loop entirely.
 */
export const useConversationOlderPageState = (
  conversationId: string | null,
): { isLoadingOlder: boolean; hasMoreOlder: boolean } => {
  const isLoadingOlder = useConversationMessagesStore((state) =>
    conversationId ? (state.byConversationId[conversationId]?.isLoadingOlder ?? false) : false,
  );
  const hasMoreOlder = useConversationMessagesStore((state) =>
    conversationId ? (state.byConversationId[conversationId]?.hasMoreOlder ?? false) : false,
  );
  return { isLoadingOlder, hasMoreOlder };
};
