/**
 * Repository seam for global conversation routes.
 * Isolates database operations from route handlers for testability.
 *
 * SCOPE, since the message-table merge (epic "Agent-Session Single Source of
 * Truth", Phase 4 / D6, PR 12): this module owns `conversations` ROWS only.
 * Every operation it used to have on the `messages` TABLE — read a message,
 * edit one, soft/hard-delete one, purge, recompute `lastMessageAt` — moved to
 * `message-repository.ts`, which is now the one writer AND the one reader for
 * durable messages of every kind. `chat-message-repository.ts` was absorbed
 * there wholesale and deleted.
 *
 * The plan's phrasing was "merge both repositories into message-repository";
 * what actually merged is both repositories' MESSAGE surfaces, because that is
 * what the two message tables becoming one makes redundant. A conversation's
 * title, its history listing and its usage log are not messages, and burying
 * them inside a message repository would trade one misnamed seam for another.
 * They belong beside `conversation-repository.ts` — a consolidation for the
 * naming phase (D7), not for the riskiest PR of the message cutover.
 */

import { db } from '@pagespace/db/db'
import { eq, and, desc, sql, lt, exists, isNull } from '@pagespace/db/operators'
import { aiUsageLogs } from '@pagespace/db/schema/monitoring'
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { createId } from '@paralleldrive/cuid2';
import { invalidate as invalidateCompaction } from '@/lib/ai/core/compaction/compaction-repository';
import { emitConversationLifecycle } from '@/lib/repositories/conversation-rev';

// Types
export interface ConversationSummary {
  id: string;
  title: string | null;
  type: string;
  contextId: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  /** Null for a plain (non-session) conversation. */
  workspaceId: string | null;
}

export interface Conversation extends ConversationSummary {
  userId: string;
  isActive: boolean;
  updatedAt: Date;
  /** Set when closed out of its session's listing; null while open (or never session-bound). */
  closedInWorkspaceAt: Date | null;
}

export interface CreateConversationInput {
  title?: string | null;
  type?: string;
  contextId?: string | null;
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
        workspaceId: conversations.workspaceId,
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
        workspaceId: conversations.workspaceId,
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

    if (newConversation) {
      emitConversationLifecycle('created', { ...newConversation, rev: Number(newConversation.rev) });
    }
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
        workspaceId: conversations.workspaceId,
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
        rev: sql`${conversations.rev} + 1`,
      })
      .where(and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId)
      ))
      .returning();

    if (updatedConversation) {
      emitConversationLifecycle(
        'updated',
        { ...updatedConversation, rev: Number(updatedConversation.rev) },
        undefined,
        { title },
      );
    }
    return updatedConversation || null;
  },

  /**
   * Auto-title from the first user message, never overwriting an existing
   * title (IS NULL guard lives in the SQL, so it's race-safe to call on
   * every message). Rev-bumped + emitted like every lifecycle mutation.
   */
  async autoTitleConversation(conversationId: string, title: string): Promise<void> {
    const [updated] = await db
      .update(conversations)
      .set({ title, updatedAt: new Date(), rev: sql`${conversations.rev} + 1` })
      .where(and(eq(conversations.id, conversationId), isNull(conversations.title)))
      .returning();
    if (updated) {
      emitConversationLifecycle('updated', { ...updated, rev: Number(updated.rev) }, undefined, { title });
    }
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
        rev: sql`${conversations.rev} + 1`,
      })
      .where(and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId)
      ))
      .returning();

    if (deletedConversation) {
      emitConversationLifecycle('deleted', { ...deletedConversation, rev: Number(deletedConversation.rev) });
    }

    // Invalidate only when the user-scoped delete actually matched a row —
    // a caller holding someone else's conversation ID must not be able to
    // disturb that conversation's compaction state.
    if (deletedConversation) {
      await invalidateCompaction(conversationId, { source: 'global' });
    }

    return deletedConversation || null;
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
