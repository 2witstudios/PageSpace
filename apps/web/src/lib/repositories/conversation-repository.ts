/**
 * Repository for conversation database operations.
 * This seam isolates query-builder details from route handlers,
 * enabling proper unit testing of routes without ORM chain mocking.
 */

import { db } from '@pagespace/db/db'
import { eq, and, sql, inArray } from '@pagespace/db/operators'
import { chatMessages, pages } from '@pagespace/db/schema/core'
import { userActivities } from '@pagespace/db/schema/monitoring'
import { conversations } from '@pagespace/db/schema/conversations';
import { isClickHouseEnabled } from '@pagespace/lib/observability/clickhouse-client';
import { insertUserActivity } from '@pagespace/lib/observability/analytics-inserts';
import { invalidate as invalidateCompaction } from '@/lib/ai/core/compaction/compaction-repository';

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
  conversationUserId: string | null;
  isShared: boolean | null;
  [key: string]: unknown; // Index signature for Drizzle execute compatibility
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
    // Structured content format (textParts/originalContent from saveMessageToDatabase)
    if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.originalContent && typeof parsed.originalContent === 'string') {
        return parsed.originalContent.substring(0, 100);
      }
      if (Array.isArray(parsed.textParts) && parsed.textParts.length > 0 && typeof parsed.textParts[0] === 'string') {
        return parsed.textParts[0].substring(0, 100);
      }
      if (parsed.parts?.[0]?.text) {
        return parsed.parts[0].text.substring(0, 100);
      }
    }
    // Legacy array format
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].text) {
      return parsed[0].text.substring(0, 100);
    }
    // JSON parsed but didn't match expected formats - use raw content
    return content.substring(0, 100);
  } catch {
    // If parsing fails, use raw content substring
    return content.substring(0, 100);
  }
}

/**
 * Generate title from preview text
 * Pure function extracted for testability.
 */
export function generateTitle(preview: string): string {
  return preview.length > 50 ? preview.substring(0, 50) + '...' : preview;
}

/**
 * True when messages already exist under this `conversationId` — ON ANY PAGE — that belong to
 * someone OTHER than `userId`.
 *
 * The "legacy conversation" shape: messages written before the conversations table was
 * populated have no `conversations` row, so an existence check alone cannot tell you who
 * owns them. Callers that authorize on the row therefore have to consult this too, or
 * they fail OPEN on exactly the conversations they cannot see.
 *
 * DELIBERATELY NOT SCOPED BY PAGE. It was, and that made it answerable only about the page the
 * caller happened to be standing on — which is the one page an attacker would simply not stand
 * on. A conversation belongs to exactly one page, so "who owns this conversation" is not a
 * per-page question, and asking it per-page let a caller squat a conversation from OUTSIDE it:
 *
 *   1. Victim has a legacy conversation C (real messages under page X, no `conversations` row).
 *   2. Attacker, on their OWN page Y, POSTs {chatId: Y, conversationId: C}. Scoped to page Y,
 *      this check saw no messages and returned false — so the send was allowed and
 *      `createConversation` (which consults the same guard) INSERTED a row `id=C` owned by the
 *      ATTACKER.
 *   3. The victim's next send on page X now finds a row it does not own and that is not shared:
 *      403, permanently. They are locked out of their own conversation, and ownership-gated
 *      actions elsewhere (deletion) now trust `conversations.userId = attacker`.
 *
 * The attacker reads nothing (history loads are page-scoped), so this is integrity and
 * availability rather than disclosure — but a permanent lockout of a victim's own history is
 * not a defensible failure mode, and the row-squat is what makes it permanent.
 *
 * Asking the question across all pages costs nothing and answers it correctly: a legitimate
 * caller's own legacy conversation contains only their messages and still passes.
 *
 * Module-level rather than a `this.`-method: `this` inside an object literal breaks the
 * moment any caller destructures a method off the repository.
 */
async function hasConflictingMessageOwner(
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const priorMessages = await db
    .select({ userId: chatMessages.userId })
    .from(chatMessages)
    .where(and(
      eq(chatMessages.conversationId, conversationId),
      eq(chatMessages.isActive, true),
    ));
  return priorMessages.some((m) => m.userId !== null && m.userId !== userId);
}

export const conversationRepository = {
  hasConflictingMessageOwner,

  /**
   * Eagerly create a conversations row when a conversation session is started
   * or continued. This establishes ownership (userId) and sets isShared=false
   * (private by default). Idempotent and safe to call on every turn of a
   * conversation — a cheap indexed lookup short-circuits once the row exists.
   *
   * Refuses to claim a caller-supplied conversationId that belongs to someone
   * else: a legacy conversation (real chat_messages, no conversations row
   * yet) must not be "claimable" by a different caller who supplies its ID —
   * ownership-gated actions elsewhere (e.g. conversation deletion) trust
   * conversations.userId. Centralized here (rather than at each call site)
   * so every caller — including pre-existing ones — gets this guarantee.
   */

  async createConversation(conversationId: string, userId: string, pageId: string, opts?: { isShared?: boolean }): Promise<void> {
    const [existing] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (existing) return;

    const hasConflictingOwner = await hasConflictingMessageOwner(conversationId, userId);
    if (hasConflictingOwner) return;

    await db
      .insert(conversations)
      .values({
        id: conversationId,
        userId,
        type: 'page',
        contextId: pageId,
        isShared: opts?.isShared ?? false,
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
  },

  /**
   * Get an AI_CHAT agent by ID
   */
  async getAiAgent(agentId: string): Promise<AiAgent | null> {
    // Conversation-hosting pages: AI_CHAT agents, and MACHINE pages — machine
    // panes anchor their terminal conversations to the machine page (Phase 4
    // pre-creates them, Phase 11's pane lists/loads them, #2166). Agent-only
    // routes (config, drives, consult) do their own AI_CHAT checks and are
    // unaffected by this widening.
    const agent = await db.query.pages.findFirst({
      where: and(
        eq(pages.id, agentId),
        inArray(pages.type, ['AI_CHAT', 'MACHINE']),
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
   * List conversations for an agent with stats, ordered by most recent.
   * Only returns conversations the user owns, plus any explicitly shared ones.
   */
  async listConversations(
    agentId: string,
    limit: number,
    offset: number,
    userId: string
  ): Promise<ConversationStats[]> {
    // 'streaming' rows are excluded from both CTEs — an in-flight placeholder must never
    // become a conversation's last-message preview (it's empty) or inflate its message
    // count. See Server Stream Durability epic PR 2.
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
          AND status != 'streaming'
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
          AND status != 'streaming'
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
        lm.last_message_content as "lastMessageContent",
        conv."userId" as "conversationUserId",
        conv."isShared" as "isShared"
      FROM conversation_stats cs
      LEFT JOIN first_user_messages fum ON cs."conversationId" = fum."conversationId"
      LEFT JOIN last_messages lm ON cs."conversationId" = lm."conversationId"
      LEFT JOIN conversations conv ON cs."conversationId" = conv.id
      WHERE (
        conv."userId" = ${userId}
        OR conv."isShared" = true
      )
      ORDER BY cs.last_message_time DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `);

    return result.rows;
  },

  /**
   * Count total conversations for an agent visible to userId.
   * Mirrors the privacy filter in listConversations.
   */
  async countConversations(agentId: string, userId: string): Promise<number> {
    const result = await db.execute<{ count: string }>(sql`
      SELECT COUNT(DISTINCT cm."conversationId") as count
      FROM chat_messages cm
      LEFT JOIN conversations conv ON cm."conversationId" = conv.id
      WHERE cm."pageId" = ${agentId}
        AND cm."isActive" = true
        AND (
          conv."userId" = ${userId}
          OR conv."isShared" = true
        )
    `);

    return Number(result.rows[0]?.count || 0);
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
        firstMessageTime: sql<Date>`MIN("createdAt")`.as('firstMessageTime'),
        lastMessageTime: sql<Date>`MAX("createdAt")`.as('lastMessageTime'),
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
    // Whole conversation cleared — any summary is stale; the tombstone also
    // guards against a first compaction that may still be in flight.
    await invalidateCompaction(conversationId, { source: 'page', pageId: agentId });
  },

  /**
   * Get a conversations row by ID. Returns null if no row exists (legacy conversation).
   */
  async getConversation(conversationId: string): Promise<typeof conversations.$inferSelect | null> {
    const result = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    return result[0] || null;
  },

  /**
   * Toggle sharing for a conversation.
   */
  async setConversationShared(conversationId: string, isShared: boolean): Promise<void> {
    await db
      .update(conversations)
      .set({ isShared, updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
  },

  /**
   * Upsert a conversation title: update if the conversations record exists, insert if not.
   * For page-agent conversations, type='page' and contextId=agentId.
   */
  async upsertConversationTitle(
    conversationId: string,
    userId: string,
    agentId: string,
    title: string
  ): Promise<{ id: string; title: string | null }> {
    const [result] = await db
      .insert(conversations)
      .values({
        id: conversationId,
        userId,
        type: 'page',
        contextId: agentId,
        title,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: conversations.id,
        set: {
          title,
          updatedAt: new Date(),
        },
      })
      .returning({ id: conversations.id, title: conversations.title });

    return result;
  },

  /**
   * Log conversation deletion for audit trail
   */
  async logConversationDeletion(data: ConversationDeletionLog): Promise<void> {
    const activity = {
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
    };

    // #890 Phase 3: user_activities cuts over to ClickHouse when enabled.
    if (isClickHouseEnabled()) {
      insertUserActivity(activity);
      return;
    }

    await db.insert(userActivities).values(activity);
  },
};
