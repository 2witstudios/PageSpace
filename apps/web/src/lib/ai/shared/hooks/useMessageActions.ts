/**
 * useMessageActions - Shared hook for message edit/delete/retry operations
 * Used by both Agent engine and Global Assistant engine
 */

import { useCallback, useRef } from 'react';
import { fetchWithAuth, patch, del } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import type { UIMessage } from 'ai';
import { getBrowserSessionId } from '@/lib/ai/core/browser-session-id';
import { getAssistantMessagesAfterLastUser } from '@/lib/ai/streams/getAssistantMessagesAfterLastUser';

const browserSessionHeaders = (): Record<string, string> => ({
  'X-Browser-Session-Id': getBrowserSessionId(),
});

type SetMessagesAction = UIMessage[] | ((previousMessages: UIMessage[]) => UIMessage[]);

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
   * Setter for messages (from useChat)
   */
  setMessages: (messages: SetMessagesAction) => void;
  /**
   * Regenerate function (from useChat)
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
  setMessages,
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

      const originalMessage = messagesRef.current.find((message) => message.id === messageId);
      if (!originalMessage) {
        return;
      }

      // Optimistically apply the edit for responsive UI feedback.
      setMessages((previousMessages) =>
        previousMessages.map((message) => {
          if (message.id !== messageId) return message;
          return {
            ...message,
            parts: message.parts.map((part) =>
              part.type === 'text' ? { ...part, text: newContent } : part
            ),
          };
        })
      );

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

        // Refetch to reconcile with server state (non-critical)
        try {
          const url = isAgentMode
            ? `/api/ai/page-agents/${agentId}/conversations/${conversationId}/messages`
            : `/api/ai/global/${conversationId}/messages`;
          const response = await fetchWithAuth(url);
          if (response.ok) {
            const data = await response.json();
            const loaded = isAgentMode
              ? data.messages || []
              : Array.isArray(data) ? data : data.messages || [];
            // NOT while our own stream is live. This is the one write here that replaces the WHOLE
            // array, and useOwnStreamMirror reads that array to find its own live stream. DB
            // history whose newest row is a foreign assistant message — another TAB of this same
            // user counts, since `isOwn` is browserSessionId-scoped — makes the mirror re-target
            // onto a finished message: our live entry goes, and Stop then aborts an id the server
            // has no stream for (user-scoped → not_found → silent by design) while the generation
            // keeps running its write tools and keeps billing.
            //
            // Skipping it costs nothing that matters: the edit is already applied optimistically
            // above and the server has it; this refetch is explicitly "non-critical" reconciliation,
            // and the next load re-syncs the array once the stream is over. Read through a ref
            // because this runs after an await.
            if (!isOwnStreamLiveRef.current) {
              setMessages(loaded);
            }
          }
        } catch {
          // Refetch failed — optimistic update already applied, server has the edit
        }
      } catch (error) {
        // Roll back only the edited message to avoid clobbering unrelated updates.
        setMessages((previousMessages) =>
          previousMessages.map((message) =>
            message.id === messageId ? originalMessage : message
          )
        );

        console.error('Failed to edit message:', error);
        toast.error('Failed to save edit. Your local changes may not persist.');
        throw error;
      }
    },
    [isAgentMode, agentId, conversationId, setMessages, onEditVersionChange]
  );

  // Delete a message
  const handleDelete = useCallback(
    async (messageId: string) => {
      if (!conversationId) return;

      const deletedMessage = messagesRef.current.find((message) => message.id === messageId);
      if (!deletedMessage) {
        return;
      }

      const previousIndex = messagesRef.current.findIndex((message) => message.id === messageId);

      // Optimistically remove the message for fast UI feedback.
      setMessages((previousMessages) =>
        previousMessages.filter((message) => message.id !== messageId)
      );

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
        // Roll back only the deleted message so we don't clobber unrelated updates
        // that may have arrived while the request was in flight.
        setMessages((previousMessages) => {
          if (previousMessages.some((message) => message.id === messageId)) {
            return previousMessages;
          }

          const nextMessages = [...previousMessages];
          const safeInsertIndex = Math.min(
            Math.max(previousIndex, 0),
            nextMessages.length
          );
          nextMessages.splice(safeInsertIndex, 0, deletedMessage);

          return nextMessages;
        });

        console.error('Failed to delete message:', error);
        toast.error('Failed to delete message');
        throw error;
      }
    },
    [isAgentMode, agentId, conversationId, setMessages]
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

      // Remove them from state using functional updater to avoid stale snapshot
      setMessages((previousMessages) =>
        previousMessages.filter(
          (m) => !assistantMessagesToDelete.some((toDelete) => toDelete.id === m.id)
        )
      );
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
  }, [isAgentMode, agentId, conversationId, setMessages, regenerate]);

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
