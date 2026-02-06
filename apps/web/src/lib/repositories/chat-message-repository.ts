/**
 * Repository for chat message database operations.
 * This seam isolates query-builder details from route handlers,
 * enabling proper unit testing of routes without ORM chain mocking.
 */

import { db, chatMessages, eq, and } from '@pagespace/db';

// Types for repository operations
export interface ChatMessage {
  id: string;
  pageId: string;
  conversationId: string;
  userId: string | null;
  role: string;
  content: string;
  messageType: 'standard' | 'todo_list';
  isActive: boolean;
  createdAt: Date;
  editedAt: Date | null;
  toolCalls: unknown | null;
  toolResults: unknown | null;
}

/**
 * Process message content, preserving structured content format if present.
 * Pure function extracted for testability.
 */
export function processMessageContentUpdate(
  existingContent: string,
  newContent: string
): string {
  try {
    const parsed = JSON.parse(existingContent);
    if (parsed.textParts && parsed.partsOrder) {
      // Update only textParts, preserve structure
      parsed.textParts = [newContent];
      parsed.originalContent = newContent;
      return JSON.stringify(parsed);
    }
  } catch {
    // Plain text, use as-is
  }
  return newContent;
}

export const chatMessageRepository = {
  /**
   * Get messages for a page, optionally filtered by conversationId
   */
  async getMessagesForPage(
    pageId: string,
    conversationId?: string
  ): Promise<ChatMessage[]> {
    const messages = await db
      .select()
      .from(chatMessages)
      .where(
        conversationId
          ? and(
              eq(chatMessages.pageId, pageId),
              eq(chatMessages.isActive, true),
              eq(chatMessages.conversationId, conversationId)
            )
          : and(
              eq(chatMessages.pageId, pageId),
              eq(chatMessages.isActive, true)
            )
      )
      .orderBy(chatMessages.createdAt);

    return messages as ChatMessage[];
  },

  /**
   * Get a single message by ID
   */
  async getMessageById(messageId: string): Promise<ChatMessage | null> {
    const [message] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId));

    return (message as ChatMessage) || null;
  },

  /**
   * Update a message's content and set editedAt timestamp
   */
  async updateMessageContent(
    messageId: string,
    content: string
  ): Promise<void> {
    await db
      .update(chatMessages)
      .set({
        content,
        editedAt: new Date(),
      })
      .where(eq(chatMessages.id, messageId));
  },

  /**
   * Soft delete a message by setting isActive to false
   */
  async softDeleteMessage(messageId: string): Promise<void> {
    await db
      .update(chatMessages)
      .set({ isActive: false })
      .where(eq(chatMessages.id, messageId));
  },
};
