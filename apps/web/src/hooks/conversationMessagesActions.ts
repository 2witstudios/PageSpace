import type { UIMessage } from 'ai';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import type { ConversationCacheEntry } from '@/stores/conversationMessages/seedEmpty';
import type { MessageEditPayload } from '@/lib/ai/streams/applyMessageEdit';
import type { AskUserAnswerPayload, AskUserAnswerRevertPayload } from '@/lib/ai/streams/applyAskUserAnswer';
import { persistQueuedSends } from '@/stores/conversationMessages/queuedSendsPersistence';
import type { ToolApprovalResponsePayload, ToolApprovalRevertPayload } from '@/lib/ai/streams/applyToolApprovalResponse';

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
    rev?: number | null,
  ): void =>
    useConversationMessagesStore.getState().applyLoad(conversationId, generation, messages, pagination, rev),
  failLoad: (conversationId: string, generation: number): void =>
    useConversationMessagesStore.getState().failLoad(conversationId, generation),
  /** The conversation's rev watermark (Agent-Session SSoT epic, Phase 2), or null when no load has established one. */
  getRev: (conversationId: string): number | null =>
    useConversationMessagesStore.getState().getRev(conversationId),
  /** Advance the watermark after an event's payload was applied — monotonic; no-op for an uncached conversation. */
  advanceRev: (conversationId: string, rev: number): void =>
    useConversationMessagesStore.getState().advanceRev(conversationId, rev),
  /** Imperative snapshot read of a conversation's cache entry (defaults when never seen). */
  getEntry: (conversationId: string): ConversationCacheEntry =>
    useConversationMessagesStore.getState().getEntry(conversationId),
  /** True when the conversation has a REAL cache entry (loaded/seeded/sent this session) — see the store docblock. */
  hasEntry: (conversationId: string): boolean =>
    useConversationMessagesStore.getState().hasEntry(conversationId),
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
  /** `rev`: the deleting event's post-write rev, when it carried one — see PendingMutation. */
  applyDelete: (conversationId: string, messageId: string, rev?: number): void =>
    useConversationMessagesStore.getState().applyDelete(conversationId, messageId, rev),
  /** Optimistic ask_user answer patch — the resume POST's own commit reconciles it once persisted. */
  applyAskUserAnswer: (conversationId: string, payload: AskUserAnswerPayload): void =>
    useConversationMessagesStore.getState().applyAskUserAnswer(conversationId, payload),
  /** Reverts an optimistic ask_user answer (the resume POST rejected) back to input-available. */
  revertAskUserAnswer: (conversationId: string, payload: AskUserAnswerRevertPayload): void =>
    useConversationMessagesStore.getState().revertAskUserAnswer(conversationId, payload),
  /** Optimistic tool-approval answer patch — the resume POST's own commit reconciles it once persisted. */
  applyToolApprovalResponse: (conversationId: string, payload: ToolApprovalResponsePayload): void =>
    useConversationMessagesStore.getState().applyToolApprovalResponse(conversationId, payload),
  /** Reverts an optimistic approval answer (the resume POST rejected) back to approval-requested. */
  revertToolApprovalResponse: (conversationId: string, payload: ToolApprovalRevertPayload): void =>
    useConversationMessagesStore.getState().revertToolApprovalResponse(conversationId, payload),
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
  applyConfirmedMessage: (conversationId: string, message: UIMessage, rev?: number): void =>
    useConversationMessagesStore.getState().applyConfirmedMessage(conversationId, message, rev),
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
  /** Silently commit an already-fetched server list as loaded truth; dropped if the token went stale. Merges onto older loaded pages — see mergeSnapshotTail. */
  applyServerSnapshot: (
    conversationId: string,
    generationToken: number,
    messages: UIMessage[],
    pagination?: { hasMore: boolean; nextCursor: string | null },
    rev?: number | null,
  ): void =>
    useConversationMessagesStore.getState().applyServerSnapshot(conversationId, generationToken, messages, pagination, rev),
  /** Mark a freshly-minted conversation loaded-empty (nothing to fetch for it). */
  seedConversation: (conversationId: string): void =>
    useConversationMessagesStore.getState().seedConversation(conversationId),

  // ── SEND QUEUE (issue #2676) ─────────────────────────────────────────────
  // Every mutation re-persists the queue, so localStorage can never disagree
  // with the in-memory state a reload would restore from. The queue is the
  // only client-held state whose loss silently breaks a promise (a queued
  // message was never sent anywhere), which is why it alone persists — see
  // queuedSendsPersistence.

  /** The conversation's queued messages, in dispatch order. */
  getQueuedSends: (conversationId: string): UIMessage[] =>
    useConversationMessagesStore.getState().queuedSendsByConversationId[conversationId] ?? [],
  /** Appends in FIFO order; false when the queue is full (`MAX_QUEUED_SENDS`). */
  enqueueQueuedSend: (conversationId: string, message: UIMessage): boolean => {
    const enqueued = useConversationMessagesStore.getState().enqueueQueuedSend(conversationId, message);
    if (enqueued) persistQueuedSends(conversationId, conversationMessagesActions.getQueuedSends(conversationId));
    return enqueued;
  },
  removeQueuedSend: (conversationId: string, messageId: string): void => {
    useConversationMessagesStore.getState().removeQueuedSend(conversationId, messageId);
    persistQueuedSends(conversationId, conversationMessagesActions.getQueuedSends(conversationId));
  },
  /** Removes and returns the oldest entry (the drain dispatches it), or null when empty. */
  shiftQueuedSend: (conversationId: string): UIMessage | null => {
    const head = useConversationMessagesStore.getState().shiftQueuedSend(conversationId);
    if (head) persistQueuedSends(conversationId, conversationMessagesActions.getQueuedSends(conversationId));
    return head;
  },
  /** A drained entry whose dispatch rejected goes back to the head — never lost. */
  requeueQueuedSend: (conversationId: string, message: UIMessage): void => {
    useConversationMessagesStore.getState().requeueQueuedSend(conversationId, message);
    persistQueuedSends(conversationId, conversationMessagesActions.getQueuedSends(conversationId));
  },
  clearQueuedSends: (conversationId: string): void => {
    useConversationMessagesStore.getState().clearQueuedSends(conversationId);
    persistQueuedSends(conversationId, conversationMessagesActions.getQueuedSends(conversationId));
  },
  /** Restore-on-mount: entries arrive exactly as persisted, ids intact. */
  setQueuedSends: (conversationId: string, messages: UIMessage[]): void => {
    useConversationMessagesStore.getState().setQueuedSends(conversationId, messages);
    persistQueuedSends(conversationId, conversationMessagesActions.getQueuedSends(conversationId));
  },
};
