/**
 * Repository seam for global conversation routes.
 * Isolates database operations from route handlers for testability.
 */

import { db, conversations, messages, aiUsageLogs, eq, and, desc, sql } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';

// Types
export interface ConversationSummary {
  id: string;
  title: string | null;
  type: string;
  contextId: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
}

export interface Conversation extends ConversationSummary {
  userId: string;
  isActive: boolean;
  updatedAt: Date;
}

export interface CreateConversationInput {
  title?: string | null;
  type?: string;
  contextId?: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  content: string;
  role: string;
  isActive: boolean;
}

export interface UsageLog {
  id: string;
  timestamp: Date | null;
  userId: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
  conversationId: string | null;
  messageId: string | null;
  pageId: string | null;
  driveId: string | null;
  success: boolean | null;
  error: string | null;
  contextSize: number | null;
  messageCount: number | null;
  wasTruncated: boolean | null;
}

export interface UsageSummary {
  billing: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    totalCost: number;
  };
  context: {
    currentContextSize: number;
    messagesInContext: number;
    contextWindowSize: number;
    contextUsagePercent: number;
    wasTruncated: boolean;
  } | null;
  mostRecentModel: string | null;
  mostRecentProvider: string | null;
}

/**
 * Pure function: Calculate usage summary from logs
 * @param logs - Usage logs, must be sorted by timestamp descending (most recent first)
 * @param getContextWindow - Callback to get context window size for a given model
 * @returns Aggregated usage summary with billing, context info, and most recent model/provider
 */
export function calculateUsageSummary(
  logs: UsageLog[],
  getContextWindow: (model: string) => number
): UsageSummary {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let mostRecentModel: string | null = null;
  let mostRecentProvider: string | null = null;

  for (const log of logs) {
    totalInputTokens += log.inputTokens || 0;
    totalOutputTokens += log.outputTokens || 0;
    totalTokens += log.totalTokens || 0;
    totalCost += log.cost || 0;
  }

  // Get most recent model/provider from the first log (most recent due to desc order)
  if (logs.length > 0) {
    mostRecentModel = logs[0].model;
    mostRecentProvider = logs[0].provider;
  }

  // Get context metrics from most recent log (current conversation state)
  const mostRecentLog = logs[0];
  const contextWindowSize = mostRecentModel ? getContextWindow(mostRecentModel) : 200000;
  const currentContextSize = mostRecentLog?.contextSize || 0;
  const contextUsagePercent = currentContextSize > 0 && contextWindowSize > 0
    ? Math.round((currentContextSize / contextWindowSize) * 100)
    : 0;

  return {
    billing: {
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      totalCost: Number(totalCost.toFixed(6)),
    },
    context: mostRecentLog ? {
      currentContextSize,
      messagesInContext: mostRecentLog.messageCount || 0,
      contextWindowSize,
      contextUsagePercent,
      wasTruncated: mostRecentLog.wasTruncated || false,
    } : null,
    mostRecentModel,
    mostRecentProvider,
  };
}

export interface ListConversationsPaginatedInput {
  limit?: number;
  cursor?: string;
  direction?: 'before' | 'after';
}

export interface PaginatedConversationsResult {
  conversations: ConversationSummary[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
    prevCursor: string | null;
    limit: number;
  };
}

export const globalConversationRepository = {
  /**
   * List all active conversations for a user, ordered by lastMessageAt
   * @deprecated Use listConversationsPaginated for better performance
   */
  async listConversations(userId: string): Promise<ConversationSummary[]> {
    return db
      .select({
        id: conversations.id,
        title: conversations.title,
        type: conversations.type,
        contextId: conversations.contextId,
        lastMessageAt: conversations.lastMessageAt,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .where(and(
        eq(conversations.userId, userId),
        eq(conversations.isActive, true)
      ))
      .orderBy(desc(conversations.lastMessageAt));
  },

  /**
   * List active conversations for a user with cursor-based pagination
   */
  async listConversationsPaginated(
    userId: string,
    options: ListConversationsPaginatedInput = {}
  ): Promise<PaginatedConversationsResult> {
    const { limit = 20, cursor, direction = 'before' } = options;
    const maxLimit = Math.min(limit, 100);

    // Build query conditions
    const conditions = [
      eq(conversations.userId, userId),
      eq(conversations.isActive, true)
    ];

    // Add cursor condition if provided - use compound cursor (lastMessageAt + id) for stable ordering
    if (cursor) {
      // Get the cursor conversation's lastMessageAt and id
      const [cursorConv] = await db
        .select({ lastMessageAt: conversations.lastMessageAt, id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, cursor))
        .limit(1);

      if (cursorConv?.lastMessageAt) {
        if (direction === 'before') {
          // Get conversations older than cursor (earlier lastMessageAt)
          // Use compound condition: either earlier timestamp, or same timestamp but smaller id
          conditions.push(
            sql`(${conversations.lastMessageAt} < ${cursorConv.lastMessageAt} OR (${conversations.lastMessageAt} = ${cursorConv.lastMessageAt} AND ${conversations.id} < ${cursorConv.id}))`
          );
        } else {
          // Get conversations newer than cursor (later lastMessageAt)
          // Use compound condition: either later timestamp, or same timestamp but larger id
          conditions.push(
            sql`(${conversations.lastMessageAt} > ${cursorConv.lastMessageAt} OR (${conversations.lastMessageAt} = ${cursorConv.lastMessageAt} AND ${conversations.id} > ${cursorConv.id}))`
          );
        }
      } else if (cursorConv) {
        // Cursor conversation exists but has null lastMessageAt - use id-only comparison
        if (direction === 'before') {
          conditions.push(sql`${conversations.id} < ${cursorConv.id}`);
        } else {
          conditions.push(sql`${conversations.id} > ${cursorConv.id}`);
        }
      }
    }

    // Query with limit + 1 to check for more
    const results = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        type: conversations.type,
        contextId: conversations.contextId,
        lastMessageAt: conversations.lastMessageAt,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .where(and(...conditions))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(maxLimit + 1);

    const hasMore = results.length > maxLimit;
    const conversationsToReturn = hasMore ? results.slice(0, maxLimit) : results;

    // Determine cursors
    const nextCursor = hasMore && conversationsToReturn.length > 0
      ? conversationsToReturn[conversationsToReturn.length - 1].id
      : null;

    const prevCursor = conversationsToReturn.length > 0 && cursor
      ? conversationsToReturn[0].id
      : null;

    return {
      conversations: conversationsToReturn,
      pagination: {
        hasMore,
        nextCursor,
        prevCursor,
        limit: maxLimit,
      },
    };
  },

  /**
   * Create a new conversation for a user
   */
  async createConversation(userId: string, input: CreateConversationInput): Promise<Conversation> {
    const conversationId = createId();
    const now = new Date();

    const [newConversation] = await db
      .insert(conversations)
      .values({
        id: conversationId,
        userId,
        title: input.title || null,
        type: input.type || 'global',
        contextId: input.contextId || null,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
        isActive: true,
      })
      .returning();

    return newConversation;
  },

  /**
   * Get the most recent active global conversation for a user
   */
  async getActiveGlobalConversation(userId: string): Promise<ConversationSummary | null> {
    const results = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        type: conversations.type,
        contextId: conversations.contextId,
        lastMessageAt: conversations.lastMessageAt,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .where(and(
        eq(conversations.userId, userId),
        eq(conversations.type, 'global'),
        eq(conversations.isActive, true)
      ))
      .orderBy(desc(conversations.createdAt))
      .limit(1);

    return results[0] || null;
  },

  /**
   * Get a specific conversation by ID (verifying user ownership)
   */
  async getConversationById(userId: string, conversationId: string): Promise<Conversation | null> {
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId),
        eq(conversations.isActive, true)
      ));

    return conversation || null;
  },

  /**
   * Update conversation title
   */
  async updateConversationTitle(userId: string, conversationId: string, title: string): Promise<Conversation | null> {
    const [updatedConversation] = await db
      .update(conversations)
      .set({
        title,
        updatedAt: new Date(),
      })
      .where(and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId)
      ))
      .returning();

    return updatedConversation || null;
  },

  /**
   * Soft delete a conversation
   */
  async softDeleteConversation(userId: string, conversationId: string): Promise<Conversation | null> {
    const [deletedConversation] = await db
      .update(conversations)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId)
      ))
      .returning();

    return deletedConversation || null;
  },

  /**
   * Get an active message by ID within a conversation
   * Only returns messages that haven't been soft-deleted
   */
  async getMessageById(conversationId: string, messageId: string): Promise<Message | null> {
    const [message] = await db
      .select()
      .from(messages)
      .where(and(
        eq(messages.id, messageId),
        eq(messages.conversationId, conversationId),
        eq(messages.isActive, true)
      ));

    return message || null;
  },

  /**
   * Update message content
   */
  async updateMessageContent(messageId: string, content: string): Promise<void> {
    await db
      .update(messages)
      .set({
        content,
        editedAt: new Date()
      })
      .where(eq(messages.id, messageId));
  },

  /**
   * Soft delete a message
   */
  async softDeleteMessage(messageId: string): Promise<void> {
    await db
      .update(messages)
      .set({ isActive: false })
      .where(eq(messages.id, messageId));
  },

  /**
   * Get usage logs for a conversation
   */
  async getUsageLogs(conversationId: string): Promise<UsageLog[]> {
    return db
      .select({
        id: aiUsageLogs.id,
        timestamp: aiUsageLogs.timestamp,
        userId: aiUsageLogs.userId,
        provider: aiUsageLogs.provider,
        model: aiUsageLogs.model,
        inputTokens: aiUsageLogs.inputTokens,
        outputTokens: aiUsageLogs.outputTokens,
        totalTokens: aiUsageLogs.totalTokens,
        cost: aiUsageLogs.cost,
        conversationId: aiUsageLogs.conversationId,
        messageId: aiUsageLogs.messageId,
        pageId: aiUsageLogs.pageId,
        driveId: aiUsageLogs.driveId,
        success: aiUsageLogs.success,
        error: aiUsageLogs.error,
        contextSize: aiUsageLogs.contextSize,
        messageCount: aiUsageLogs.messageCount,
        wasTruncated: aiUsageLogs.wasTruncated,
      })
      .from(aiUsageLogs)
      .where(eq(aiUsageLogs.conversationId, conversationId))
      .orderBy(desc(aiUsageLogs.timestamp));
  },
};
