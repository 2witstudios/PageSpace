/**
 * Repository seam for global conversation routes.
 * Isolates database operations from route handlers for testability.
 */

import { db } from '@pagespace/db/db'
import { eq, and, desc, sql, lt, exists } from '@pagespace/db/operators'
import { aiUsageLogs } from '@pagespace/db/schema/monitoring'
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { createId } from '@paralleldrive/cuid2';
import { invalidate as invalidateCompaction } from '@/lib/ai/core/compaction/compaction-repository';
import { loggers } from '@pagespace/lib/logging/logger-config';

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
  createdAt: Date;
  status: 'streaming' | 'complete' | 'interrupted';
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

/**
 * SQL condition: conversation has at least one active message.
 * Used to filter history — empty (never-messaged) conversations are hidden.
 * Handles both new rows (lastMessageAt=null) and existing stale rows from before
 * lazy creation was introduced.
 */
const hasMessages = exists(
  db
    .select({ one: sql`1` })
    .from(messages)
    .where(and(
      eq(messages.conversationId, conversations.id),
      eq(messages.isActive, true),
    ))
);

/**
 * Runs `recomputeLastMessageAt` isolated from its caller's own outcome
 * (#2153 review follow-up). `softDeleteMessage`/`hardDeleteMessage`/
 * `purgeInactiveMessages` all commit their primary write BEFORE calling
 * this, in a separate statement — so an unguarded throw here would surface
 * as a failure of an operation that already succeeded, and for
 * `hardDeleteMessage` specifically, the deleted row is gone, so there is no
 * "retry this call" path that would ever repair the stale timestamp. Purge
 * additionally loops over multiple conversations per call, where a single
 * throw would abort every conversation after it in iteration order and
 * lose the already-correct purge count. A logged-and-swallowed failure here
 * leaves `lastMessageAt` stale until the next mutation on that conversation
 * recomputes it fresh — worse than immediate consistency, but strictly
 * better than an unrelated 500 or an abandoned purge loop.
 *
 * Deliberately NOT used by `materialize-interrupted-stream.ts`: that
 * caller's recompute sits inside the same try/catch as the message write
 * itself, so a recompute failure there is meant to propagate and degrade
 * like a failed write — the opposite of isolating it.
 */
async function recomputeLastMessageAtIsolated(
  conversationId: string,
  caller: string
): Promise<void> {
  try {
    await globalConversationRepository.recomputeLastMessageAt(conversationId);
  } catch (error) {
    loggers.ai.warn(`${caller}: lastMessageAt recompute failed`, {
      conversationId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
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
        eq(conversations.isActive, true),
        hasMessages,
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
      eq(conversations.isActive, true),
      hasMessages,
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
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
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
        // lastMessageAt stays null until the first message is saved.
        // This prevents the conversation from appearing in history before any messages exist.
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
        eq(conversations.isActive, true),
        hasMessages,
      ))
      .orderBy(sql`${conversations.lastMessageAt} DESC NULLS LAST`, desc(conversations.createdAt))
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

    // Invalidate only when the user-scoped delete actually matched a row —
    // a caller holding someone else's conversation ID must not be able to
    // disturb that conversation's compaction state.
    if (deletedConversation) {
      await invalidateCompaction(conversationId, { source: 'global' });
    }

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
   * The single "message mutated" recompute for `conversations.lastMessageAt`
   * (#2153). Every mutation that can change which active message is newest —
   * soft-delete, hard-delete, purge, and the interrupted-stream materializer
   * — calls this instead of writing the field ad hoc, so a recovered or
   * deleted message can't leave a conversation sorted on a stale timestamp.
   *
   * Runs in its own transaction and locks the conversation row FIRST, before
   * reading the surviving messages. Without this, a concurrent writer (a
   * normal message save, or another recompute from a concurrent delete)
   * targeting the same conversation can commit between this function's own
   * SELECT and UPDATE, and this UPDATE then silently overwrites that
   * writer's fresher timestamp with a stale snapshot. The lock forces
   * concurrent recomputes (and any other writer to this row — a plain
   * UPDATE takes the same implicit row lock even without FOR UPDATE) to
   * serialize: whichever runs second only proceeds after the first commits,
   * at which point its own SELECT sees the first's already-committed state.
   * Mirrors `recomputeConversationLastMessage` in dm-message-repository.ts.
   */
  async recomputeLastMessageAt(conversationId: string): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .for('update');

      const [newest] = await tx
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .where(and(
          eq(messages.conversationId, conversationId),
          eq(messages.isActive, true)
        ))
        .orderBy(desc(messages.createdAt))
        .limit(1);

      await tx
        .update(conversations)
        .set({ lastMessageAt: newest ? newest.createdAt : null })
        .where(eq(conversations.id, conversationId));
    });
  },

  /**
   * Soft delete a message
   */
  async softDeleteMessage(messageId: string): Promise<void> {
    const [row] = await db
      .update(messages)
      .set({ isActive: false })
      .where(eq(messages.id, messageId))
      .returning({ conversationId: messages.conversationId });

    if (row) {
      await recomputeLastMessageAtIsolated(row.conversationId, 'softDeleteMessage');
    }
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

  /**
   * Permanently delete a message from the database
   */
  async hardDeleteMessage(messageId: string): Promise<void> {
    const [row] = await db
      .delete(messages)
      .where(eq(messages.id, messageId))
      .returning({ conversationId: messages.conversationId });

    if (row) {
      await recomputeLastMessageAtIsolated(row.conversationId, 'hardDeleteMessage');
    }
  },

  /**
   * Purge soft-deleted messages older than the cutoff date.
   * Returns the number of rows removed.
   */
  async purgeInactiveMessages(olderThan: Date): Promise<number> {
    const result = await db
      .delete(messages)
      .where(
        and(
          eq(messages.isActive, false),
          lt(messages.createdAt, olderThan)
        )
      )
      .returning({ id: messages.id, conversationId: messages.conversationId });

    const affectedConversationIds = new Set(result.map((m) => m.conversationId));
    for (const conversationId of affectedConversationIds) {
      await recomputeLastMessageAtIsolated(conversationId, 'purgeInactiveMessages');
    }

    return result.length;
  },

  /**
   * Purge soft-deleted conversations older than the cutoff date.
   * Returns the number of rows removed.
   */
  async purgeInactiveConversations(olderThan: Date): Promise<number> {
    const result = await db
      .delete(conversations)
      .where(
        and(
          eq(conversations.isActive, false),
          lt(conversations.updatedAt, olderThan)
        )
      )
      .returning({ id: conversations.id });

    return result.length;
  },
};
