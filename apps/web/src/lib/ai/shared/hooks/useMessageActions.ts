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
  /**
   * Is THIS surface's own stream live for `conversationId` right now?
   *
   * Passed in because this hook is surface-agnostic and cannot read it. It gates the one write
   * here that replaces the WHOLE messages array (the post-edit reconcile refetch) — see its use.
   */
  isOwnStreamLive?: boolean;
}

interface UseMessageActionsResult {
  /** Edit a message's content */
  handleEdit: (messageId: string, newContent: string) => Promise<void>;
  /** Delete a message */
  handleDelete: (messageId: string) => Promise<void>;
  /** Retry/regenerate the last response */
  handleRetry: () => Promise<void>;
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
  isOwnStreamLive = false,
}: UseMessageActionsOptions): UseMessageActionsResult {
  const isAgentMode = Boolean(agentId);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // Read after an await, so a ref rather than the captured prop.
  const isOwnStreamLiveRef = useRef(isOwnStreamLive);
  isOwnStreamLiveRef.current = isOwnStreamLive;

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

  // Retry/regenerate the last response
  const handleRetry = useCallback(async () => {
    if (!conversationId) return;

    const currentMessages = messagesRef.current;

    // Before regenerating, clean up old assistant responses after the last user message
    const assistantMessagesToDelete = getAssistantMessagesAfterLastUser(currentMessages);

    if (assistantMessagesToDelete.length > 0) {
      // Delete them from the database in parallel — calls are independent
      await Promise.allSettled(
        assistantMessagesToDelete.map((msg) => {
          const url = isAgentMode
            ? `/api/ai/page-agents/${agentId}/conversations/${conversationId}/messages/${msg.id}`
            : `/api/ai/global/${conversationId}/messages/${msg.id}`;
          return del(url, undefined, { headers: browserSessionHeaders() }).catch((error) => {
            console.error('Failed to delete old assistant message:', error);
          });
        })
      );

      // No local array to prune — `useCacheMessageActions` deletes the same rows from the
      // cache, which is both what renders and what `regenerate` composes its request from.
    }

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
