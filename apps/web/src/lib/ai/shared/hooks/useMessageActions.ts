/**
 * useMessageActions - Shared hook for message edit/delete/retry operations
 * Used by both Agent engine and Global Assistant engine
 */

import { useCallback } from 'react';
import { fetchWithAuth, patch, del } from '@/lib/auth-fetch';
import { toast } from 'sonner';
import type { UIMessage } from 'ai';

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
  setMessages: (messages: UIMessage[]) => void;
  /**
   * Regenerate function (from useChat)
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
}: UseMessageActionsOptions): UseMessageActionsResult {
  const isAgentMode = Boolean(agentId);

  // Edit a message
  const handleEdit = useCallback(
    async (messageId: string, newContent: string) => {
      if (!conversationId) return;

      try {
        if (isAgentMode) {
          // Agent mode: Use agent API
          await patch(
            `/api/ai/page-agents/${agentId}/conversations/${conversationId}/messages/${messageId}`,
            { content: newContent }
          );

          // Refetch agent messages
          const response = await fetchWithAuth(
            `/api/ai/page-agents/${agentId}/conversations/${conversationId}/messages`
          );
          if (response.ok) {
            const data = await response.json();
            setMessages(data.messages || []);
          }
        } else {
          // Global mode: Use global API
          await patch(
            `/api/ai/global/${conversationId}/messages/${messageId}`,
            { content: newContent }
          );

          // Refetch messages
          const response = await fetchWithAuth(
            `/api/ai/global/${conversationId}/messages`
          );
          if (response.ok) {
            const data = await response.json();
            const loadedMessages = Array.isArray(data) ? data : data.messages || [];
            setMessages(loadedMessages);
          }
        }

        onEditVersionChange?.();
        toast.success('Message updated successfully');
      } catch (error) {
        console.error('Failed to edit message:', error);
        toast.error('Failed to edit message');
        throw error;
      }
    },
    [isAgentMode, agentId, conversationId, setMessages, onEditVersionChange]
  );

  // Delete a message
  const handleDelete = useCallback(
    async (messageId: string) => {
      if (!conversationId) return;

      try {
        if (isAgentMode) {
          await del(
            `/api/ai/page-agents/${agentId}/conversations/${conversationId}/messages/${messageId}`
          );
        } else {
          await del(`/api/ai/global/${conversationId}/messages/${messageId}`);
        }

        // Optimistically update local state
        const filtered = messages.filter((m) => m.id !== messageId);
        setMessages(filtered);

        toast.success('Message deleted');
      } catch (error) {
        console.error('Failed to delete message:', error);
        toast.error('Failed to delete message');
        throw error;
      }
    },
    [isAgentMode, agentId, conversationId, messages, setMessages]
  );

  // Retry/regenerate the last response
  const handleRetry = useCallback(async () => {
    if (!conversationId) return;

    // Before regenerating, clean up old assistant responses after the last user message
    const lastUserMsgIndex = messages.map((m) => m.role).lastIndexOf('user');

    if (lastUserMsgIndex !== -1) {
      // Get all assistant messages after the last user message
      const assistantMessagesToDelete = messages
        .slice(lastUserMsgIndex + 1)
        .filter((m) => m.role === 'assistant');

      // Delete them from the database
      for (const msg of assistantMessagesToDelete) {
        try {
          if (isAgentMode) {
            await del(
              `/api/ai/page-agents/${agentId}/conversations/${conversationId}/messages/${msg.id}`
            );
          } else {
            await del(`/api/ai/global/${conversationId}/messages/${msg.id}`);
          }
        } catch (error) {
          console.error('Failed to delete old assistant message:', error);
        }
      }

      // Remove them from state
      const filteredMessages = messages.filter(
        (m) => !assistantMessagesToDelete.some((toDelete) => toDelete.id === m.id)
      );
      setMessages(filteredMessages);
    }

    // Now regenerate with a clean slate
    regenerate({
      body: isAgentMode
        ? {
            chatId: agentId,
            conversationId,
          }
        : undefined,
    });
  }, [isAgentMode, agentId, conversationId, messages, setMessages, regenerate]);

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
