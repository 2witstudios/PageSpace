/**
 * Repository for conversation database operations.
 * This seam isolates query-builder details from route handlers,
 * enabling proper unit testing of routes without ORM chain mocking.
 */

import { db, chatMessages, pages, userActivities, eq, and, sql } from '@pagespace/db';

// Types for repository operations
export interface AiAgent {
  id: string;
  title: string;
  type: string;
  driveId: string;
}

export interface ConversationStats {
  conversationId: string;
  firstMessageTime: Date;
  lastMessageTime: Date;
  messageCount: number;
  firstUserMessage: string | null;
  lastMessageRole: string | null;
  lastMessageContent: string | null;
}

export interface ConversationMetadata {
  messageCount: number;
  firstMessageTime: Date | null;
  lastMessageTime: Date | null;
}

export interface ConversationDeletionLog {
  userId: string;
  conversationId: string;
  agentId: string;
  metadata: ConversationMetadata | null;
}

/**
 * Extract preview text from message content (JSON or raw text)
 * Pure function extracted for testability.
 */
export function extractPreviewText(content: string | null): string {
  if (!content) return 'New conversation';

  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].text) {
      return parsed[0].text.substring(0, 100);
    } else if (typeof parsed === 'object' && parsed.parts?.[0]?.text) {
      return parsed.parts[0].text.substring(0, 100);
    }
  } catch {
    // If parsing fails, use raw content substring
    return content.substring(0, 100);
  }

  return 'New conversation';
}

/**
 * Generate title from preview text
 * Pure function extracted for testability.
 */
export function generateTitle(preview: string): string {
  return preview.length > 50 ? preview.substring(0, 50) + '...' : preview;
}

export const conversationRepository = {
  /**
   * Get an AI_CHAT agent by ID
   */
  async getAiAgent(agentId: string): Promise<AiAgent | null> {
    const agent = await db.query.pages.findFirst({
      where: and(
        eq(pages.id, agentId),
        eq(pages.type, 'AI_CHAT'),
        eq(pages.isTrashed, false)
      ),
      columns: {
        id: true,
        title: true,
        type: true,
        driveId: true,
      },
    });

    return agent || null;
  },

  /**
   * List conversations for an agent with stats, ordered by most recent
   */
  async listConversations(
    agentId: string,
    limit: number,
    offset: number
  ): Promise<ConversationStats[]> {
    const result = await db.execute<ConversationStats>(sql`
      WITH ranked_messages AS (
        SELECT
          "conversationId",
          content,
          role,
          "createdAt",
          ROW_NUMBER() OVER (
            PARTITION BY "conversationId", role
            ORDER BY "createdAt" ASC
          ) as first_user_msg_rank,
          ROW_NUMBER() OVER (
            PARTITION BY "conversationId"
            ORDER BY "createdAt" DESC
          ) as last_msg_rank
        FROM chat_messages
        WHERE "pageId" = ${agentId}
          AND "isActive" = true
      ),
      conversation_stats AS (
        SELECT
          "conversationId",
          MIN("createdAt") as first_message_time,
          MAX("createdAt") as last_message_time,
          COUNT(*) as message_count
        FROM chat_messages
        WHERE "pageId" = ${agentId}
          AND "isActive" = true
        GROUP BY "conversationId"
      ),
      first_user_messages AS (
        SELECT "conversationId", content as first_user_message
        FROM ranked_messages
        WHERE role = 'user' AND first_user_msg_rank = 1
      ),
      last_messages AS (
        SELECT
          "conversationId",
          role as last_message_role,
          content as last_message_content
        FROM ranked_messages
        WHERE last_msg_rank = 1
      )
      SELECT
        cs."conversationId" as "conversationId",
        cs.first_message_time as "firstMessageTime",
        cs.last_message_time as "lastMessageTime",
        cs.message_count as "messageCount",
        fum.first_user_message as "firstUserMessage",
        lm.last_message_role as "lastMessageRole",
        lm.last_message_content as "lastMessageContent"
      FROM conversation_stats cs
      LEFT JOIN first_user_messages fum ON cs."conversationId" = fum."conversationId"
      LEFT JOIN last_messages lm ON cs."conversationId" = lm."conversationId"
      ORDER BY cs.last_message_time DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `);

    return result.rows;
  },

  /**
   * Count total conversations for an agent
   */
  async countConversations(agentId: string): Promise<number> {
    const result = await db
      .select({
        count: sql<number>`COUNT(DISTINCT ${chatMessages.conversationId})`,
      })
      .from(chatMessages)
      .where(and(
        eq(chatMessages.pageId, agentId),
        eq(chatMessages.isActive, true)
      ));

    return Number(result[0]?.count || 0);
  },

  /**
   * Check if a conversation exists (has at least one active message)
   */
  async conversationExists(agentId: string, conversationId: string): Promise<boolean> {
    const result = await db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(and(
        eq(chatMessages.pageId, agentId),
        eq(chatMessages.conversationId, conversationId),
        eq(chatMessages.isActive, true)
      ))
      .limit(1);

    return result.length > 0;
  },

  /**
   * Get conversation metadata (for audit logging before deletion)
   */
  async getConversationMetadata(
    agentId: string,
    conversationId: string
  ): Promise<ConversationMetadata | null> {
    const result = await db
      .select({
        messageCount: sql<number>`COUNT(*)`.as('messageCount'),
        firstMessageTime: sql<Date>`MIN(created_at)`.as('firstMessageTime'),
        lastMessageTime: sql<Date>`MAX(created_at)`.as('lastMessageTime'),
      })
      .from(chatMessages)
      .where(and(
        eq(chatMessages.pageId, agentId),
        eq(chatMessages.conversationId, conversationId),
        eq(chatMessages.isActive, true)
      ));

    return result[0] || null;
  },

  /**
   * Soft-delete a conversation (mark all messages as inactive)
   */
  async softDeleteConversation(agentId: string, conversationId: string): Promise<void> {
    await db
      .update(chatMessages)
      .set({ isActive: false })
      .where(and(
        eq(chatMessages.pageId, agentId),
        eq(chatMessages.conversationId, conversationId)
      ));
  },

  /**
   * Log conversation deletion for audit trail
   */
  async logConversationDeletion(data: ConversationDeletionLog): Promise<void> {
    await db.insert(userActivities).values({
      userId: data.userId,
      action: 'delete',
      resource: 'conversation',
      resourceId: data.conversationId,
      pageId: data.agentId,
      metadata: {
        conversationId: data.conversationId,
        agentId: data.agentId,
        messageCount: data.metadata?.messageCount || 0,
        firstMessageTime: data.metadata?.firstMessageTime,
        lastMessageTime: data.metadata?.lastMessageTime,
        deletionReason: 'user_initiated',
      },
    });
  },
};

export type ConversationRepository = typeof conversationRepository;
