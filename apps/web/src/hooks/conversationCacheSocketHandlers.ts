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
 * shared by GlobalChatContext (global channel) and useConversationSubscription
 * (per-conversation) so the paths cannot drift.
 *
 * DISPATCH IS BY THE EVENT'S CONVERSATION, not a subscriber-supplied "active"
 * one. A single active-conversation gate assumed each subscriber watches one
 * conversation — panes broke that: several conversations on one channel are
 * on screen at once, none of them the subscriber's "active" one, and every
 * event for them was silently dropped (replies vanishing on completion,
 * collaborator messages/edits/deletes never appearing). An event applies to
 * whichever conversation it names.
 *
 * NO `hasEntry` GATE (Agent-Session SSoT epic, Phase 2 / plan PR 3). Every
 * handler below used to early-return unless the conversation already had a real
 * cache entry, on the reasoning "cached ⇔ some surface can render it". That
 * reasoning had a hole exactly the size of the epic's canonical bug: the entry
 * is created by a LOAD, and the load is asynchronous, so a dispatch landing in
 * the window between a pane mounting and its first fetch committing was dropped
 * on the floor with nothing to re-deliver it. The gate is now unnecessary rather
 * than merely removed — `useConversationSubscription` ensures a cache entry
 * BEFORE it joins the conversation's room, so "subscribed" implies "cached" by
 * construction instead of by timing. The residual cost of a write for a
 * conversation nothing renders is one map key.
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
    conversationMessagesActions.applyRemoteUserMessage(payload.conversationId, message);
  },

  onMessageEdited: (payload: { messageId: string; conversationId: string; parts: UIMessage['parts']; editedAt: string }) => {
    const editPayload: MessageEditPayload = {
      messageId: payload.messageId,
      parts: payload.parts,
      editedAt: new Date(payload.editedAt),
    };
    conversationMessagesActions.applyEdit(payload.conversationId, editPayload);
  },

  onMessageDeleted: (payload: { messageId: string; conversationId: string }) => {
    conversationMessagesActions.applyDelete(payload.conversationId, payload.messageId);
  },

  onStreamComplete: (messageId: string, completedConvId?: string, _info?: { joinFailed: boolean }, aborted?: boolean) => {
    const stream = getActiveStreamById(messageId);
    if (stream && stream.parts.length > 0) {
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
    // Unless the sender's own onFinish already committed a final row whose status is CONSISTENT with
    // this event (buildOwnStreamCommitOnFinish) — then a reload only adds a
    // loading flip. A locally-Stopped 'interrupted' row does NOT suppress a
    // non-aborted completion: the server may have outrun the abort and
    // persisted the full reply — see cacheHasConsistentFinalMessage.
    if (!completedConvId) return;
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
