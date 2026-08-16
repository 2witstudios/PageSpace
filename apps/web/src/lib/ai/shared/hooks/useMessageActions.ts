/**
 * useMessageActions - Shared hook for message edit/delete/retry operations
 * Used by both Agent engine and Global Assistant engine
 */

import { useCallback, useRef } from 'react';
import { patch, del } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import type { UIMessage } from 'ai';
import { getBrowserSessionId } from '@/lib/ai/core/browser-session-id';
import { getAssistantMessagesAfterLastUser } from '@/lib/ai/streams/getAssistantMessagesAfterLastUser';
import { readStopEpoch } from '@/lib/ai/streams/stopRequests';

const browserSessionHeaders = (): Record<string, string> => ({
  'X-Browser-Session-Id': getBrowserSessionId(),
});

interface UseMessageActionsOptions {
  /**
   * For agent mode: the agent/page ID
   * For global mode: null
   */
  agentId: string | null;
  /**
   * Current conversation ID
   */
  conversationId: string | null;
  /**
   * Current messages array
   */
  messages: UIMessage[];
  /**
   * Regenerate function (from useChatSession)
   */
  regenerate: (options?: { body?: Record<string, unknown> }) => void;
  /**
   * Optional callback when edit version changes (for forcing re-renders)
   */
  onEditVersionChange?: () => void;
}

interface UseMessageActionsResult {
  /** Edit a message's content */
  handleEdit: (messageId: string, newContent: string) => Promise<void>;
  /** Delete a message */
  handleDelete: (messageId: string) => Promise<void>;
  /**
   * Retry/regenerate the last response. Resolves FALSE when nothing was dispatched — no
   * conversation, or a Stop landed while the superseded rows were being deleted — so a caller
   * holding a pendingSend can release it (see `useSendHandoff.releasePendingSend`).
   */
  handleRetry: () => Promise<boolean>;
  /** Get the last assistant message ID */
  lastAssistantMessageId: string | undefined;
  /** Get the last user message ID */
  lastUserMessageId: string | undefined;
}

/**
 * Hook for message action handlers in AI chat views
 * Handles edit, delete, and retry operations with appropriate API endpoints
 */
export function useMessageActions({
  agentId,
  conversationId,
  messages,
  regenerate,
  onEditVersionChange,
}: UseMessageActionsOptions): UseMessageActionsResult {
  const isAgentMode = Boolean(agentId);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Edit a message
  const handleEdit = useCallback(
    async (messageId: string, newContent: string) => {
      if (!conversationId) return;

      // Existence guard only. It used to also be the rollback snapshot; nothing is written
      // locally now, so all it does is refuse to PATCH a message this conversation does not
      // have — which is still worth refusing.
      if (!messagesRef.current.some((message) => message.id === messageId)) {
        return;
      }

      // NO optimistic transport write. The optimistic UI is the CACHE write in
      // `useCacheMessageActions.handleEdit` (`conversationMessagesActions.applyEdit`), which
      // is what actually renders under store-first rendering; the write that used to be here
      // went into useChat's array, which never rendered anything.
      try {
        if (isAgentMode) {
          await patch(
            `/api/ai/page-agents/${agentId}/conversations/${conversationId}/messages/${messageId}`,
            { content: newContent },
            { headers: browserSessionHeaders() }
          );
        } else {
          await patch(
            `/api/ai/global/${conversationId}/messages/${messageId}`,
            { content: newContent },
            { headers: browserSessionHeaders() }
          );
        }

        onEditVersionChange?.();
        toast.success('Message updated successfully');

        // THE RECONCILE REFETCH IS GONE, and its absence is the fix rather than a loss.
        //
        // It re-read the whole conversation and replaced useChat's array with it, guarded by
        // `isOwnStreamLive` because that array was the own-stream mirror's read source: DB
        // history whose newest row was a foreign assistant message made the mirror re-target
        // onto a finished message, the live entry went, and Stop then named an id the server
        // had no stream for while the generation kept running and kept billing.
        //
        // There is no transport array to replace now, and the cache — which is what renders —
        // is written by `useCacheMessageActions` from the edit itself. A server-side
        // reconciliation would be a whole-conversation refetch to update a container nothing
        // reads, so it is deleted rather than re-pointed at the cache: the next real load
        // re-syncs, exactly as this refetch's own comment described it ("non-critical").
      } catch (error) {
        // No local rollback: nothing was optimistically written HERE. The cache write in
        // `useCacheMessageActions` happens only after this resolves, so a failure leaves the
        // rendered content untouched — which is what the rollback was arranging for.
        console.error('Failed to edit message:', error);
        toast.error('Failed to save edit. Your local changes may not persist.');
        throw error;
      }
    },
    [isAgentMode, agentId, conversationId, onEditVersionChange]
  );

  // Delete a message
  const handleDelete = useCallback(
    async (messageId: string) => {
      if (!conversationId) return;

      // Existence guard only — see handleEdit.
      if (!messagesRef.current.some((message) => message.id === messageId)) {
        return;
      }

      try {
        if (isAgentMode) {
          await del(
            `/api/ai/page-agents/${agentId}/conversations/${conversationId}/messages/${messageId}`,
            undefined,
            { headers: browserSessionHeaders() }
          );
        } else {
          await del(
            `/api/ai/global/${conversationId}/messages/${messageId}`,
            undefined,
            { headers: browserSessionHeaders() }
          );
        }

        toast.success('Message deleted');
      } catch (error) {
        // No local rollback, for the same reason as handleEdit: the rendered removal is the
        // cache write in `useCacheMessageActions`, which only runs once this resolves.
        console.error('Failed to delete message:', error);
        toast.error('Failed to delete message');
        throw error;
      }
    },
    [isAgentMode, agentId, conversationId]
  );

  // Retry/regenerate the last response.
  //
  // Reports whether it DISPATCHED, like `handleSend`: a caller holding a pendingSend has to know,
  // because a wrapped callback that returns without dispatching moves none of the handoff
  // effect's dependencies and would leave the composer showing Stop until unmount. See
  // `useSendHandoff.releasePendingSend`.
  const handleRetry = useCallback(async (): Promise<boolean> => {
    if (!conversationId) return false;

    // Snapshot BEFORE the DELETE round trip below, checked after it — see stopRequests, and the
    // dispatch guard at the bottom of this function.
    const stopEpochAtStart = readStopEpoch(conversationId);

    const currentMessages = messagesRef.current;

    // Before regenerating, clean up old assistant responses after the last user message
    const assistantMessagesToDelete = getAssistantMessagesAfterLastUser(currentMessages);

    if (assistantMessagesToDelete.length > 0) {
      // AWAITED, AND IT HAS TO BE — this is a hard ordering dependency, not caution.
      //
      // The obvious latency win here is to fire these DELETEs alongside the regenerate POST
      // instead of before it: the local cache row is already gone (useCacheMessageActions ran
      // applyDelete synchronously), so from the client's side the deletes look like a pure
      // prefix, and dropping the await would take a whole round trip off the retry.
      //
      // It would also silently corrupt the retry. The regenerate POST does NOT regenerate from
      // the messages the client sends: `handleChatTurn` loads the conversation from the DATABASE,
      // and both surfaces say so at their history load — "We use database-loaded messages, NOT
      // requestMessages from client" (global-chat-turn.ts), "Used ONLY to extract new user
      // message, NOT for conversation history" (page-chat-turn.ts). Nothing server-side
      // supersedes the trailing assistant rows on a regenerate, either. Race the DELETEs against
      // the POST and the model is handed
      // its own previous answer as the newest turn — it rewrites or continues that answer instead
      // of re-answering the user, and does it nondeterministically, depending on which request
      // reached the DB first.
      //
      // The round trip is real and it is paid. What it is NOT any more is INVISIBLE: the whole
      // retry now runs inside the surface's `wrapSend`, so the composer locks and offers Stop
      // from the click (see useCacheMessageActions.handleRetry).
      //
      // The deletes are already concurrent WITH EACH OTHER — one Promise.allSettled over N
      // independent requests, not N sequential awaits — so the cost here is one round trip, not
      // one per superseded message.
      const outcomes = await Promise.allSettled(
        assistantMessagesToDelete.map((msg) => {
          const url = isAgentMode
            ? `/api/ai/page-agents/${agentId}/conversations/${conversationId}/messages/${msg.id}`
            : `/api/ai/global/${conversationId}/messages/${msg.id}`;
          return del(url, undefined, { headers: browserSessionHeaders() });
        })
      );

      // A FAILED DELETE BREAKS THE SAME INVARIANT AS A RACED ONE (CodeRabbit).
      //
      // The rejections used to be swallowed into a console line, which made the ordering above
      // load-bearing only when the network cooperated: a row that failed to delete is still in
      // the database, the server rebuilds history FROM the database, and the model is handed its
      // own previous answer as the newest turn — the exact corruption the await is here to
      // prevent, arrived by a different route. Awaiting something and then ignoring what it said
      // is not an ordering guarantee.
      //
      // So a failed delete refuses the dispatch, and says so. Silence would be worse than the
      // old console line: the cache row is already gone (`useCacheMessageActions` applied it
      // synchronously), so the user would see their answer vanish and nothing replace it, with
      // no idea why or that a reload will bring it back.
      const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
      if (failed.length > 0) {
        for (const outcome of failed) {
          console.error('Failed to delete old assistant message:', outcome.reason);
        }
        toast.error('Could not clear the previous reply, so the retry was not started.');
        return false;
      }

      // No local array to prune — `useCacheMessageActions` deletes the same rows from the
      // cache, which is both what renders and what `regenerate` composes its request from.
    }

    // THE STOP THE SERVER COULD NOT HONOUR. Retry now runs inside `wrapSend`, so the composer
    // has been offering Stop for the whole DELETE round trip above — but no stream row exists
    // yet, so `markAbortRequested` matches nothing, the abort answers `not_found`, and
    // `reportAbortOutcome` is deliberately silent about that. Dispatching here anyway would make
    // that Stop a lie of exactly the kind this epic deleted `rawStop` over: the press appeared to
    // do nothing and a generation started regardless.
    //
    // The deletes have already committed and cannot be taken back, so a stopped retry leaves the
    // superseded answer gone and nothing regenerating — which is what the user asked for.
    if (readStopEpoch(conversationId) !== stopEpochAtStart) return false;

    // Now regenerate with a clean slate. conversationId is included for both
    // modes — global mode's useChat transport is frozen at first construction
    // (see global-chat-request-body.ts), so the body is what actually
    // determines which conversation this lands in after a switch, same as a
    // regular send.
    regenerate({
      body: isAgentMode
        ? {
            chatId: agentId,
            conversationId,
          }
        : {
            conversationId,
          },
    });
    return true;
  }, [isAgentMode, agentId, conversationId, regenerate]);

  // Compute last message IDs for UI
  const lastAssistantMessageId = messages
    .filter((m) => m.role === 'assistant')
    .slice(-1)[0]?.id;

  const lastUserMessageId = messages
    .filter((m) => m.role === 'user')
    .slice(-1)[0]?.id;

  return {
    handleEdit,
    handleDelete,
    handleRetry,
    lastAssistantMessageId,
    lastUserMessageId,
  };
}
