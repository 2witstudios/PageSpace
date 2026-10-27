import type { ChatOnFinishCallback, UIMessage } from 'ai';
import { getActiveStreamById } from '@/hooks/useActiveStream';
import { commitConfirmedReply } from '@/hooks/commitConfirmedReply';
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
 * What/whether to commit is decided by planOwnStreamCommit; HOW to commit is
 * the shared commitConfirmedReply protocol (F1 promote-first ordering, F6
 * snapshot heal) — the same code path the socket commit uses, so the two
 * cannot drift. `promoteOwnSends` is unconditionally true here: onFinish only
 * ever fires for this tab's own request.
 *
 * `onFinish` runs in the stream-teardown task, before React commits the
 * `ready` render's effects — so the mirror's pending-streams entry still
 * exists here (its startedAt keeps the bubble's timestamp) and the cache row
 * lands before the mirror's removeStream, making the streaming → confirmed
 * transition atomic in selectRenderedMessages.
 *
 * useChat reads callbacks at Chat construction, so the closed-over ids must
 * be per-Chat-stable: callers' chat ids embed EVERY id this closes over
 * (`agent-session-chat:${agentId}:${conversationId}` /
 * `assistant-session-chat:${conversationId}`), forcing Chat recreation
 * whenever either changes.
 */
export const buildOwnStreamCommitOnFinish = (deps: {
  conversationId: string;
  /** Agent page id for the snapshot-heal endpoint; null = global assistant. */
  agentId: string | null;
}): ChatOnFinishCallback<UIMessage> => {
  const { conversationId, agentId } = deps;
  return (options) => {
    const message = planOwnStreamCommit({
      message: options.message,
      isAbort: options.isAbort,
      isDisconnect: options.isDisconnect,
      isError: options.isError,
      startedAt: getActiveStreamById(options.message.id)?.startedAt,
    });
    if (!message) return;
    commitConfirmedReply(conversationId, message, {
      promoteOwnSends: true,
      refreshSnapshot: (id) => refreshConversationSnapshot(agentId, id),
    });
  };
};
