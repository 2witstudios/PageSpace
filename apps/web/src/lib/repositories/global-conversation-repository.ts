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
// Recency, the sort key and the cursor codecs are declared ONCE, in the module
// the Agents-surface listing imports too — see that file's header for the
// drift between the two that this listing was on the wrong side of.
import {
  recencyExpr,
  sortKeyExpr,
  encodeCursor,
  decodeCursor,
  olderThanCursor,
} from '@/lib/conversations/conversation-recency';

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
  /**
   * Always "older than this conversation". There is no `direction` toggle:
   * returning the page truly adjacent on the other side needs the ORDER BY
   * inverted (ascending toward the cursor, then reversed back for display),
   * and the branch that used to claim `after` did not do that — it reused the
   * `before` comparator under an unchanged `DESC` order, which returns the
   * globally newest matches rather than the adjacent page. No caller ever sent
   * it (`SidebarHistoryTab` hardcodes `direction=before`, and nothing else
   * calls this), so it is gone rather than kept unverified and wrong — the
   * same call `listAllConversationsPaginated` documents for the same reason.
   */
  cursor?: string;
}

export interface PaginatedConversationsResult {
  conversations: ConversationSummary[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
    limit: number;
  };
}

/**
 * SQL condition: conversation has at least one active message.
 * Used to filter history — empty (never-messaged) conversations are hidden.
 * Handles both new rows (lastMessageAt=null) and existing stale rows from before
 * lazy creation was introduced.
 *
 * NOT a type filter, though it used to act as one. Before the message-table
 * merge (epic "Agent-Session Single Source of Truth", Phase 4 / D6) `messages`
 * held global-assistant rows ONLY — page and client threads wrote to
 * `chat_messages` — so this predicate incidentally excluded every other kind,
 * and the listings below never needed to say so. The merge's backfill moved all
 * of it into one table and the accident stopped holding. Scope is now stated
 * explicitly by `isGlobalAssistantThread`; this asks only what it says.
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
 * The scope of this repository's history listings: the Global Assistant's own
 * threads, and nothing else.
 *
 * `SidebarHistoryTab` shows the history of the SELECTED agent. With a page
 * agent selected it calls that agent's own endpoint
 * (`/api/ai/page-agents/{id}/conversations`); with the Global Assistant
 * selected it calls the route these functions back. The page-agent branch was
 * always scoped — this one was not, and once page rows entered `messages` it
 * returned every conversation of every type, burying the assistant's own
 * history under hundreds of page-agent threads (measured on one account:
 * 107 page rows in the first 180). Clicking one of those also mis-routed, since
 * the global branch loads a row through `loadGlobalConversation`.
 *
 * A `type: 'client'` thread (minted by `POST /api/v1/conversations` for
 * pagespace-cli and other OpenAI-compatible clients) is excluded by the same
 * rule: it belongs to an API caller, not to this sidebar.
 */
const isGlobalAssistantThread = eq(conversations.type, 'global');

export const globalConversationRepository = {
  /**
   * List all active Global Assistant conversations for a user, newest activity
   * first.
   * @deprecated Use listConversationsPaginated for better performance
   */
  async listConversations(userId: string): Promise<ConversationSummary[]> {
    return db
      .select({
        id: conversations.id,
        title: conversations.title,
        type: conversations.type,
        contextId: conversations.contextId,
        // The REAL last activity, not the stored column — see `recencyExpr`.
        lastMessageAt: recencyExpr,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .where(and(
        eq(conversations.userId, userId),
        eq(conversations.isActive, true),
        isGlobalAssistantThread,
        hasMessages,
      ))
      .orderBy(desc(sortKeyExpr), desc(conversations.id));
  },

  /**
   * List active conversations for a user with cursor-based pagination
   */
  async listConversationsPaginated(
    userId: string,
    options: ListConversationsPaginatedInput = {}
  ): Promise<PaginatedConversationsResult> {
    const { limit = 20, cursor } = options;
    // Clamped at BOTH ends, matching `listAllConversationsPaginated`. An
    // upper bound alone leaves two broken states for a non-positive `limit`:
    // `0` queries `.limit(1)`, which makes `hasMore` true with an empty page
    // and therefore a null `nextCursor` — a caller told there is more, with no
    // way to advance — and a negative reaches Postgres as a negative LIMIT and
    // raises. The route guards its own input, so no shipped path reaches this,
    // but the method is exported and called directly (this module's own
    // integration suite does), so the guard is not structural (review finding).
    const maxLimit = Math.min(Math.max(limit, 1), 100);

    // Build query conditions
    const conditions = [
      eq(conversations.userId, userId),
      eq(conversations.isActive, true),
      isGlobalAssistantThread,
      hasMessages,
    ];

    // An OPAQUE cursor carrying the sort key the caller last saw, evaluated in
    // the same total order this query sorts by — see `olderThanCursor`. What it
    // replaces re-read the cursor ROW live and branched on
    // `if (cursorConv?.lastMessageAt)`, which is falsy for every conversation
    // that never had the column written, and fell through to comparing `id`
    // alone. Ordering by one key while paginating by another does not merely
    // reorder a page: rows between the two boundaries are returned by NO page.
    // Proven against real Postgres in this module's integration suite — six
    // conversations, pages of two, four rows reachable.
    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded) conditions.push(olderThanCursor(decoded));
    }

    // Query with limit + 1 to check for more
    const results = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        type: conversations.type,
        contextId: conversations.contextId,
        lastMessageAt: recencyExpr,
        sortKeyValue: sortKeyExpr,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .where(and(...conditions))
      .orderBy(desc(sortKeyExpr), desc(conversations.id))
      .limit(maxLimit + 1);

    const hasMore = results.length > maxLimit;
    const rows = hasMore ? results.slice(0, maxLimit) : results;
    // `sortKeyValue` is this query's own ordering key, not part of the wire
    // shape — it exists to be frozen into the next cursor and is dropped here.
    const conversationsToReturn = rows.map(({ sortKeyValue: _sortKey, ...row }) => row);

    const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
    const nextCursor = hasMore && lastRow
      ? encodeCursor(lastRow.sortKeyValue, lastRow.id)
      : null;

    return {
      conversations: conversationsToReturn,
      pagination: {
        hasMore,
        nextCursor,
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
      })
      .from(conversations)
      .where(and(
        eq(conversations.userId, userId),
        eq(conversations.type, 'global'),
        eq(conversations.isActive, true),
        hasMessages,
      ))
      // The SAME ordering the history listing uses, because this answers the
      // same question — which thread was used most recently — and two answers
      // to it is the drift this module was on the wrong side of. The two
      // diverge exactly where the raw column is absent but activity is not: a
      // thread with messages and no `lastMessageAt` (one production account
      // holds 30) sorted LAST under `NULLS LAST` while ranking FIRST by real
      // activity, so the sidebar would show it at the top of history while this
      // resumed a different one. `sortKeyExpr` is total, so it needs no null
      // handling of its own, and its final fallback is `createdAt` — the same
      // tiebreak this used to spell out.
      .orderBy(desc(sortKeyExpr), desc(conversations.id))
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
