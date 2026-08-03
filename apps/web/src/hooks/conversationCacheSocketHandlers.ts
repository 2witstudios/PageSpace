import type { UIMessage } from 'ai';
import { getActiveStreamById } from '@/hooks/useActiveStream';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { commitConfirmedReply } from '@/hooks/commitConfirmedReply';
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
      // The shared F1/F6 commit protocol — see commitConfirmedReply. Without this
      // commit the reply flashes to missing: for OWN streams the mirror removes the
      // pending entry the instant status changes. epic leaf 6.8 (D
      // ixpwr76xepu2x9v4pxgksyhz): the terminal status badges a crash-reaped or
      // Stopped stream as 'interrupted' the instant this tab hears about it,
      // instead of only after the next reload.
      commitConfirmedReply(
        stream.conversationId,
        synthesizeAssistantMessage(messageId, stream.parts, stream.startedAt, aborted ? 'interrupted' : 'complete'),
        { promoteOwnSends: stream.isOwn, refreshSnapshot },
      );
      return;
    }
    // No usable store entry (SSE join failed / zero parts): the message IS durably
    // persisted — reload the conversation's cache entry rather than losing it.
    // Only for a CACHED conversation (uncached ⇒ nothing renders it; its
    // eventual loader fetches the DB truth), and unless the sender's own
    // onFinish already committed a final row whose status is CONSISTENT with
    // this event (buildOwnStreamCommitOnFinish) — then a reload only adds a
    // loading flip. A locally-Stopped 'interrupted' row does NOT suppress a
    // non-aborted completion: the server may have outrun the abort and
    // persisted the full reply — see cacheHasConsistentFinalMessage.
    if (!completedConvId || !conversationMessagesActions.hasEntry(completedConvId)) return;
    const cacheHasFinalMessage = cacheHasConsistentFinalMessage(
      conversationMessagesActions.getEntry(completedConvId).messages,
      messageId,
      aborted === true,
    );
    if (shouldReloadOnComountComplete(stream, cacheHasFinalMessage)) {
      void reloadConversation(completedConvId);
    }
  },
});
