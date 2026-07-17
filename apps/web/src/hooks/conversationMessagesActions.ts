import type { UIMessage } from 'ai';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import type { ConversationCacheEntry } from '@/stores/conversationMessages/seedEmpty';
import type { MessageEditPayload } from '@/lib/ai/streams/applyMessageEdit';
import type { AskUserAnswerPayload, AskUserAnswerRevertPayload } from '@/lib/ai/streams/applyAskUserAnswer';

/**
 * Facade — the sanctioned way for a component to WRITE to
 * `useConversationMessagesStore` (see PR 4 board: container-agnostic consumer
 * rule). Components call these instead of `useConversationMessagesStore.getState()`
 * directly, so a state-container swap (zustand → @adobe/data ECS, per the
 * platform spike) stays a facade-internal change instead of a consumer rewrite.
 *
 * Plain functions, not a hook: every call site here is imperative (a user
 * action or a socket-event callback), never a render-time read.
 */
export const conversationMessagesActions = {
  /** Starts a new load generation for `conversationId`; pair with `isLoadCurrent`/`applyLoad`/`failLoad`. */
  startLoad: (conversationId: string): number => useConversationMessagesStore.getState().startLoad(conversationId),
  /** True while `generation` is still the newest `startLoad` result for `conversationId` — false once a newer load has superseded it. */
  isLoadCurrent: (conversationId: string, generation: number): boolean =>
    useConversationMessagesStore.getState().isLoadCurrent(conversationId, generation),
  applyLoad: (
    conversationId: string,
    generation: number,
    messages: UIMessage[],
    pagination?: { hasMore: boolean; nextCursor: string | null },
  ): void =>
    useConversationMessagesStore.getState().applyLoad(conversationId, generation, messages, pagination),
  failLoad: (conversationId: string, generation: number): void =>
    useConversationMessagesStore.getState().failLoad(conversationId, generation),
  /** Imperative snapshot read of a conversation's cache entry (defaults when never seen). */
  getEntry: (conversationId: string): ConversationCacheEntry =>
    useConversationMessagesStore.getState().getEntry(conversationId),
  /** Marks a "load older" fetch in flight (epic leaf 6.6) — inline indicator, no generation change. */
  startLoadingOlder: (conversationId: string): void =>
    useConversationMessagesStore.getState().startLoadingOlder(conversationId),
  /** Prepends a dedup'd older page and advances olderCursor/hasMoreOlder; generation-gated. */
  applyOlderPage: (
    conversationId: string,
    generation: number,
    messages: UIMessage[],
    hasMoreOlder: boolean,
    nextCursor: string | null,
  ): void =>
    useConversationMessagesStore.getState().applyOlderPage(conversationId, generation, messages, hasMoreOlder, nextCursor),
  /** Clears isLoadingOlder on a failed "load older" fetch; leaves the cache otherwise intact. */
  failLoadingOlder: (conversationId: string, generation: number): void =>
    useConversationMessagesStore.getState().failLoadingOlder(conversationId, generation),
  addOptimisticSend: (conversationId: string, message: UIMessage): void =>
    useConversationMessagesStore.getState().addOptimisticSend(conversationId, message),
  /** Rolls back an optimistic send whose POST rejected (epic leaf 6.5, M9). */
  removeOptimisticSendOnFailure: (conversationId: string, messageId: string): void =>
    useConversationMessagesStore.getState().removeOptimisticSendOnFailure(conversationId, messageId),
  applyEdit: (conversationId: string, payload: MessageEditPayload): void =>
    useConversationMessagesStore.getState().applyEdit(conversationId, payload),
  applyDelete: (conversationId: string, messageId: string): void =>
    useConversationMessagesStore.getState().applyDelete(conversationId, messageId),
  /** Optimistic ask_user answer patch — the resume POST's own commit reconciles it once persisted. */
  applyAskUserAnswer: (conversationId: string, payload: AskUserAnswerPayload): void =>
    useConversationMessagesStore.getState().applyAskUserAnswer(conversationId, payload),
  /** Reverts an optimistic ask_user answer (the resume POST rejected) back to input-available. */
  revertAskUserAnswer: (conversationId: string, payload: AskUserAnswerRevertPayload): void =>
    useConversationMessagesStore.getState().revertAskUserAnswer(conversationId, payload),
  /**
   * Appends a broadcast user message, reconciling it out of `optimisticSends` if
   * present. No-ops if the id is already confirmed — correct for a user message,
   * whose content never changes after creation. NOT for assistant completions
   * (an existing id is not proof of complete content there) — use
   * `applyConfirmedMessage` for those.
   */
  applyRemoteUserMessage: (conversationId: string, message: UIMessage): void =>
    useConversationMessagesStore.getState().applyRemoteUserMessage(conversationId, message),
  /**
   * Upserts a confirmed message by id: replaces an existing entry in place, or
   * appends if absent. Use for assistant-completion commits (stream-complete,
   * cross-instance recovery), where an existing row under this id may be a
   * stale/half-streamed snapshot that must be overwritten, not skipped.
   */
  applyConfirmedMessage: (conversationId: string, message: UIMessage): void =>
    useConversationMessagesStore.getState().applyConfirmedMessage(conversationId, message),
  /**
   * Promote optimistic sends into confirmed messages. Call on THIS TAB'S OWN
   * stream commit only — an own reply proves the user rows that triggered it
   * are persisted; a remote reply proves nothing about this tab's sends.
   */
  promoteOptimisticSends: (conversationId: string): void =>
    useConversationMessagesStore.getState().promoteOptimisticSends(conversationId),
  /** Capture the token a background snapshot must present at commit — call BEFORE the fetch. */
  beginServerSnapshot: (conversationId: string): number =>
    useConversationMessagesStore.getState().beginServerSnapshot(conversationId),
  /** Silently commit an already-fetched server list as loaded truth; dropped if the token went stale. */
  applyServerSnapshot: (conversationId: string, generationToken: number, messages: UIMessage[]): void =>
    useConversationMessagesStore.getState().applyServerSnapshot(conversationId, generationToken, messages),
  /** Mark a freshly-minted conversation loaded-empty (nothing to fetch for it). */
  seedConversation: (conversationId: string): void =>
    useConversationMessagesStore.getState().seedConversation(conversationId),
};
