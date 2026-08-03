import type { ChatOnFinishCallback, UIMessage } from 'ai';
import { getActiveStreamById } from '@/hooks/useActiveStream';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { refreshConversationSnapshot } from '@/hooks/conversationMessagesLoaders';
import { planOwnStreamCommit } from '@/lib/ai/streams/planOwnStreamCommit';

/**
 * Builds a useChat `onFinish` that commits the sender's finished reply into
 * the conversation message cache — the local counterpart of the socket
 * `onStreamComplete` commit (conversationCacheSocketHandlers), for surfaces
 * whose completed reply must not depend on the best-effort broadcast (panes:
 * the assistant pane has no conversation-scoped subscriber at all, and the
 * agent pane's own stream entry is already removed when its handler runs).
 *
 * Mirrors the socket commit's ordering exactly:
 * - F1: promote optimistic sends FIRST — an own reply proves the user rows
 *   that triggered it are persisted, and promoting first means the question
 *   can never render below the answer.
 * - Commit by id — upsert, never skip: an existing row under this id may be a
 *   half-streamed includeStreaming placeholder that must be overwritten.
 * - F6: background snapshot heal — the drained body is complete on a clean
 *   finish, but the DB row is authoritative for metadata (status refinement,
 *   createdAt); best-effort, generation-safe, no loading-state flip.
 *
 * `onFinish` runs in the stream-teardown task, before React commits the
 * `ready` render's effects — so the mirror's pending-streams entry still
 * exists here (its startedAt keeps the bubble's timestamp) and the cache row
 * lands before the mirror's removeStream, making the streaming → confirmed
 * transition atomic in selectRenderedMessages.
 *
 * useChat reads callbacks at Chat construction, so the closed-over ids must
 * be per-Chat-stable: callers' chat ids embed the conversationId
 * (`agent-session-chat:${conversationId}` / `assistant-session-chat:${conversationId}`),
 * forcing Chat recreation whenever it changes.
 */
export const buildOwnStreamCommitOnFinish = (deps: {
  conversationId: string;
  /** Agent page id for the snapshot-heal endpoint; null = global assistant. */
  agentId: string | null;
}): ChatOnFinishCallback<UIMessage> => {
  const { conversationId, agentId } = deps;
  return (options) => {
    const plan = planOwnStreamCommit({
      message: options.message,
      isAbort: options.isAbort,
      isDisconnect: options.isDisconnect,
      isError: options.isError,
      startedAt: getActiveStreamById(options.message.id)?.startedAt,
    });
    if (!plan) return;
    conversationMessagesActions.promoteOptimisticSends(conversationId);
    conversationMessagesActions.applyConfirmedMessage(conversationId, plan.message);
    void refreshConversationSnapshot(agentId, conversationId);
  };
};
