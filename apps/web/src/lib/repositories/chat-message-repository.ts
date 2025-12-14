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
  role: string;
  content: string;
  isActive: boolean;
  createdAt: Date;
  editedAt: Date | null;
  toolCalls: unknown | null;
  toolResults: unknown | null;
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

export type ChatMessageRepository = typeof chatMessageRepository;
