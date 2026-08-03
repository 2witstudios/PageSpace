import type { UIMessage } from 'ai';
import { getActiveStreamById } from '@/hooks/useActiveStream';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { synthesizeAssistantMessage } from '@/lib/ai/streams/synthesizeAssistantMessage';
import { shouldReloadOnComountComplete } from '@/lib/ai/streams/shouldReloadOnComountComplete';
import { cacheHasConsistentFinalMessage } from '@/lib/ai/streams/cacheHasConsistentFinalMessage';
import type { MessageEditPayload } from '@/lib/ai/streams/applyMessageEdit';

export interface ConversationCacheHandlerDeps {
  /**
   * Generation-guarded cache reload for a conversation whose completion left no
   * usable store entry (SSE join failed / zero parts) — the reply IS durably
   * persisted and must be fetched rather than lost.
   */
  reloadConversation: (conversationId: string) => void | Promise<void>;
  /**
   * Background snapshot heal after a stream-complete commit (no loading-state
   * flip) — see refreshConversationSnapshot.
   */
  refreshSnapshot: (conversationId: string) => void | Promise<void>;
}

/**
 * The ONE socket-events → conversation-cache protocol (F10, PR #2098 review),
 * shared by GlobalChatContext (global channel) and useAgentChannelMultiplayer
 * (agent channels) so the two paths cannot drift. AiChatView keeps its own
 * handlers: it additionally dual-writes into its useChat transport, which
 * neither of these subscribers can reach.
 *
 * DISPATCH IS BY THE EVENT'S CONVERSATION, not a subscriber-supplied "active"
 * one. A single active-conversation gate assumed each subscriber watches one
 * conversation — panes broke that: several conversations on one channel are
 * on screen at once, none of them the subscriber's "active" one, and every
 * event for them was silently dropped (replies vanishing on completion,
 * collaborator messages/edits/deletes never appearing). An event now applies
 * to whichever conversation it names, gated only on that conversation having
 * a real cache entry (`hasEntry`): every rendering surface loads or seeds its
 * conversation on mount, so cached ⇔ some surface can render it — and a
 * conversation nobody has cached needs no cache write (the DB row is the
 * truth its eventual loader will fetch).
 *
 * The user/edit/delete handlers fire only for a REMOTE tab's action
 * (useChannelStreamSocket drops own-tab events via isOwnStream before
 * invoking) — the local user's own edit/delete/send is written by the
 * surfaces' own handlers. Every cache action is idempotent
 * (append-if-absent / upsert-by-id), so co-mounted subscribers delivering the
 * same event twice is harmless by construction.
 */
export const buildConversationCacheHandlers = ({
  reloadConversation,
  refreshSnapshot,
}: ConversationCacheHandlerDeps) => ({
  onUserMessage: (message: UIMessage, payload: { conversationId: string }) => {
    if (!conversationMessagesActions.hasEntry(payload.conversationId)) return;
    conversationMessagesActions.applyRemoteUserMessage(payload.conversationId, message);
  },

  onMessageEdited: (payload: { messageId: string; conversationId: string; parts: UIMessage['parts']; editedAt: string }) => {
    if (!conversationMessagesActions.hasEntry(payload.conversationId)) return;
    const editPayload: MessageEditPayload = {
      messageId: payload.messageId,
      parts: payload.parts,
      editedAt: new Date(payload.editedAt),
    };
    conversationMessagesActions.applyEdit(payload.conversationId, editPayload);
  },

  onMessageDeleted: (payload: { messageId: string; conversationId: string }) => {
    if (!conversationMessagesActions.hasEntry(payload.conversationId)) return;
    conversationMessagesActions.applyDelete(payload.conversationId, payload.messageId);
  },

  onStreamComplete: (messageId: string, completedConvId?: string, _info?: { joinFailed: boolean }, aborted?: boolean) => {
    const stream = getActiveStreamById(messageId);
    if (stream && stream.parts.length > 0 && conversationMessagesActions.hasEntry(stream.conversationId)) {
      // COMMIT by id — upsert, never skip. An existing row under this id may be a
      // half-streamed includeStreaming placeholder that must be overwritten, and for
      // OWN streams the mirror removes the pending entry the instant status changes —
      // without this commit the reply flashes to missing.
      //
      // F1: an OWN reply's commit proves the user rows that triggered it are
      // persisted (the route persists the user message before generating) — promote
      // them into confirmed messages FIRST, so the reply appends after them and the
      // question can never render below the answer. A remote reply proves nothing
      // about this tab's sends, so no promotion there (ordering is already right:
      // an unconfirmed own send IS the newest content).
      if (stream.isOwn) {
        conversationMessagesActions.promoteOptimisticSends(stream.conversationId);
      }
      // epic leaf 6.8 (D ixpwr76xepu2x9v4pxgksyhz): badge a crash-reaped or Stopped
      // stream as 'interrupted' the instant this tab hears about it, instead of only
      // after the next reload — the persisted row already carries this status
      // (message-utils.ts), this just stops a live-open tab from rendering stale.
      conversationMessagesActions.applyConfirmedMessage(
        stream.conversationId,
        synthesizeAssistantMessage(messageId, stream.parts, stream.startedAt, aborted ? 'interrupted' : 'complete'),
      );
      // F6: the socket broadcast can outrace the SSE multicast's final frames, so the
      // committed parts may be truncated. The commit gives instant continuity; this
      // background snapshot reconciles the authoritative DB row (best-effort,
      // generation-safe, no loading-state flip).
      void refreshSnapshot(stream.conversationId);
      return;
    }
    // No usable store entry (SSE join failed / zero parts): the message IS durably
    // persisted — reload the conversation's cache entry rather than losing it.
    // Unless the sender's own onFinish already committed a final row whose status
    // is CONSISTENT with this event (buildOwnStreamCommitOnFinish) — then a reload
    // only adds a loading flip. A locally-Stopped 'interrupted' row does NOT
    // suppress a non-aborted completion: the server may have outrun the abort and
    // persisted the full reply — see cacheHasConsistentFinalMessage.
    const conversationCached = completedConvId
      ? conversationMessagesActions.hasEntry(completedConvId)
      : false;
    const cacheHasFinalMessage = completedConvId
      ? cacheHasConsistentFinalMessage(
          conversationMessagesActions.getEntry(completedConvId).messages,
          messageId,
          aborted === true,
        )
      : false;
    if (shouldReloadOnComountComplete(stream, completedConvId, conversationCached, cacheHasFinalMessage)) {
      void reloadConversation(completedConvId!);
    }
  },
});
