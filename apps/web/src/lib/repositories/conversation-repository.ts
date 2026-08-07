/**
 * Repository for conversation database operations.
 * This seam isolates query-builder details from route handlers,
 * enabling proper unit testing of routes without ORM chain mocking.
 */

import { db } from '@pagespace/db/db'
import { eq, and, sql, inArray, isNull, isNotNull } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { userActivities } from '@pagespace/db/schema/monitoring'
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { isClickHouseEnabled } from '@pagespace/lib/observability/clickhouse-client';
import { insertUserActivity } from '@pagespace/lib/observability/analytics-inserts';
import { kickUserFromRooms } from '@pagespace/lib/realtime/kick-client';
import { conversationRoom } from '@pagespace/lib/realtime/rooms';
import { invalidate as invalidateCompaction } from '@/lib/ai/core/compaction/compaction-repository';
import { type ConversationEventTriggeredBy } from '@/lib/websocket/conversation-events';
import { emitConversationLifecycle } from '@/lib/repositories/conversation-rev';
import { deactivateUnifiedMessagesForConversation } from '@/lib/repositories/unified-message-leg';
import { unifiedPageScope, unifiedPageScopeSql } from '@/lib/repositories/unified-message-scope';

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
  /** The session (workspace) this thread was born into — null for a plain page chat. */
  workspaceId: string | null;
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
  // Unified `messages` (Phase 4 / D6). Scoped by conversationId alone, exactly
  // as before — the point of the check is "does this id already hold someone
  // else's messages", which is a question about the id, not about a page.
  const priorMessages = await db
    .select({ userId: messages.userId })
    .from(messages)
    .where(and(
      eq(messages.conversationId, conversationId),
      eq(messages.isActive, true),
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
   * else: a legacy conversation (real messages, no conversations row
   * yet) must not be "claimable" by a different caller who supplies its ID —
   * ownership-gated actions elsewhere (e.g. conversation deletion) trust
   * conversations.userId. Centralized here (rather than at each call site)
   * so every caller — including pre-existing ones — gets this guarantee.
   *
   * Returns WHAT HAPPENED rather than void, because the difference is
   * load-bearing for session binding: `workspaceId` is written ONLY on the
   * INSERT (a thread is BORN into its session — contract invariant 1), so a
   * caller that needed the binding must know the insert did not happen.
   * Callers that only need idempotent ensure-exists semantics can ignore the
   * result exactly as before.
   */

  async createConversation(
    conversationId: string,
    userId: string,
    pageId: string,
    opts?: { isShared?: boolean; title?: string; triggeredBy?: ConversationEventTriggeredBy }
  ): Promise<'created' | 'exists' | 'message_owner_conflict'> {
    const [existing] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (existing) return 'exists';

    const hasConflictingOwner = await hasConflictingMessageOwner(conversationId, userId);
    if (hasConflictingOwner) return 'message_owner_conflict';

    // Always session-agnostic: this never writes `workspaceId` (there is no
    // param for it). A conversation that needs a session gets one afterward,
    // via `claimConversationInSession` — see `claim-conversation-in-session.ts`.
    const [inserted] = await db
      .insert(conversations)
      .values({
        id: conversationId,
        userId,
        type: 'page',
        contextId: pageId,
        isShared: opts?.isShared ?? false,
        workspaceId: null,
        title: opts?.title ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();
    // A concurrent first-write winning the race is 'exists' too — the caller's
    // insert did not happen.
    if (!inserted) return 'exists';
    // Directory event so sidebars (including the owner's other devices, and
    // server-spawned workers' owners) see the new conversation without a
    // poll. Emitted from the repository — routes never decide (SSoT §3).
    emitConversationLifecycle('created', { ...inserted, rev: Number(inserted.rev) }, opts?.triggeredBy);
    return 'created';
  },

  /**
   * Stamp a `type='client'` thread's agent page — the ONLY writer of
   * `conversations.agentPageId`, and the replacement for the transitional
   * `messages.pageId` that Phase 4 PR 15 dropped.
   *
   * An API-managed conversation (`POST /api/v1/conversations`) is minted
   * before anyone knows which agent it will talk to: the model — and therefore
   * the agent page — arrives with the first `POST /api/v1/chat/completions`.
   * So the page is claimed lazily, by that first completion.
   *
   * WRITE-ONCE, enforced by the statement rather than by a check the caller
   * could skip: `agentPageId IS NULL` in the WHERE means a later request
   * naming a different agent matches zero rows instead of re-pointing a
   * thread whose history and edit/delete permissions are already anchored to
   * the first page. Same shape, and the same reasoning, as
   * `claimConversation` above.
   *
   * `type='client'` in the WHERE too, so a mis-wired caller cannot give a page
   * or global conversation a second page link — those kinds derive their page
   * from `contextId`, and `derivedPageId()` would never read this column for
   * them anyway.
   *
   * Deliberately NOT a rev bump or a lifecycle emit: no subscriber renders
   * this column (API threads have no in-app viewer), and it is idempotent
   * bookkeeping on the hot completion path, not a content mutation.
   */
  async stampClientConversationPage(conversationId: string, pageId: string): Promise<'stamped' | 'noop'> {
    const [updated] = await db
      .update(conversations)
      .set({ agentPageId: pageId })
      .where(and(
        eq(conversations.id, conversationId),
        eq(conversations.type, 'client'),
        isNull(conversations.agentPageId),
      ))
      .returning({ id: conversations.id });
    return updated ? 'stamped' : 'noop';
  },

  /**
   * Bind a NEVER-BOUND conversation to a session — the only UPDATE of
   * `conversations.workspaceId` anywhere in the codebase, and unable to
   * re-point one: `workspaceId IS NULL` in the WHERE makes a rebind attempt
   * match zero rows rather than depending on a check the caller could skip.
   * `userId` rides the WHERE too, so ownership is enforced by the write
   * itself, closing the read-then-write gap that made the H1 rebind finding
   * exploitable in the old create-then-UPDATE shape. See
   * `claim-conversation-in-session.ts` for the full gate this backs.
   *
   * `closedInWorkspaceAt` is cleared in the same statement: a row whose former
   * session was deleted (FK `ON DELETE SET NULL`) can arrive here
   * `workspaceId`-null but still stamped closed, and binding it without
   * clearing would produce a bound-but-invisible thread that holds no cap
   * slot and shows in no listing.
   */
  async claimConversation(conversationId: string, userId: string, workspaceId: string): Promise<'claimed' | 'noop'> {
    const [updated] = await db
      .update(conversations)
      .set({
        workspaceId,
        closedInWorkspaceAt: null,
        updatedAt: new Date(),
        // Lifecycle mutation → rev bump, same statement (SSoT §3 clause 2).
        rev: sql`${conversations.rev} + 1`,
      })
      .where(and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId),
        isNull(conversations.workspaceId),
        eq(conversations.isActive, true),
      ))
      .returning();
    if (!updated) return 'noop';
    emitConversationLifecycle('updated', { ...updated, rev: Number(updated.rev) }, undefined, {
      workspaceId: workspaceId,
      closedInWorkspaceAt: null,
    });
    return 'claimed';
  },

  /**
   * Get an AI_CHAT agent by ID
   */
  async getAiAgent(agentId: string): Promise<AiAgent | null> {
    // Conversation-hosting pages: AI_CHAT agents only — agent sessions anchor
    // to the conversation itself, and the Machine page type is gone entirely.
    const agent = await db.query.pages.findFirst({
      where: and(
        eq(pages.id, agentId),
        inArray(pages.type, ['AI_CHAT']),
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
    //
    // Reads the UNIFIED `messages` table since the message-table merge (epic
    // "Agent-Session Single Source of Truth", Phase 4 / D6). Page scope is the
    // `unifiedPageScopeSql` fragment — the SQL twin of `unifiedPageScope` in
    // unified-message-scope.ts, and the same pair of predicates for the same
    // reasons.
    const result = await db.execute<ConversationStats>(sql`
      WITH page_messages AS (
        SELECT m."conversationId", m.content, m.role, m."createdAt"
        FROM messages m
        JOIN conversations pc ON pc.id = m."conversationId"
        WHERE ${unifiedPageScopeSql(agentId)}
          AND m."isActive" = true
          AND m.status != 'streaming'
      ),
      ranked_messages AS (
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
        FROM page_messages
      ),
      conversation_stats AS (
        SELECT
          "conversationId",
          MIN("createdAt") as first_message_time,
          MAX("createdAt") as last_message_time,
          COUNT(*) as message_count
        FROM page_messages
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
        conv."isShared" as "isShared",
        conv."workspaceId" as "workspaceId"
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
    // Unified `messages` + `unifiedPageScopeSql` — see listConversations above.
    // The conversation join is now an INNER join because it also carries the
    // page scope; every `messages` row has a conversation (validated FK), so
    // no row is lost by the change.
    const result = await db.execute<{ count: string }>(sql`
      SELECT COUNT(DISTINCT m."conversationId") as count
      FROM messages m
      JOIN conversations pc ON pc.id = m."conversationId"
      WHERE ${unifiedPageScopeSql(agentId)}
        AND m."isActive" = true
        AND (
          pc."userId" = ${userId}
          OR pc."isShared" = true
        )
    `);

    return Number(result.rows[0]?.count || 0);
  },

  /**
   * Check if a conversation exists (has at least one active message)
   */
  async conversationExists(agentId: string, conversationId: string): Promise<boolean> {
    // Unified `messages` (Phase 4 / D6) with the shared page scope.
    const result = await db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(
        unifiedPageScope(agentId),
        eq(messages.conversationId, conversationId),
        eq(messages.isActive, true)
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
    // Unified `messages` (Phase 4 / D6). The aggregate columns are qualified
    // now that a second table is in the FROM list — bare `"createdAt"` would be
    // ambiguous against `conversations."createdAt"`.
    const result = await db
      .select({
        messageCount: sql<number>`COUNT(*)`.as('messageCount'),
        firstMessageTime: sql<Date>`MIN(${messages.createdAt})`.as('firstMessageTime'),
        lastMessageTime: sql<Date>`MAX(${messages.createdAt})`.as('lastMessageTime'),
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(
        unifiedPageScope(agentId),
        eq(messages.conversationId, conversationId),
        eq(messages.isActive, true)
      ));

    return result[0] || null;
  },

  /**
   * Soft-delete a conversation (mark all messages as inactive)
   */
  async softDeleteConversation(agentId: string, conversationId: string): Promise<void> {
    // Both UPDATEs in one transaction — a failure between them must not
    // leave messages inactive but the canonical row still active (or vice
    // versa): a retry after a partial failure would fail whatever
    // active-message precondition the route checks, stranding the row in
    // the inconsistent state this pairing exists to eliminate (review
    // finding — chatgpt-codex-connector on PR #2296).
    //
    // The CONVERSATIONS row first, THEN its messages — not the other order.
    // The page-agent chat route's own atomic active-conversation re-check
    // (agent-sessions-runtime's sibling, apps/web/src/app/api/ai/chat/
    // route.ts) takes `SELECT ... FOR UPDATE` on THIS conversations row
    // before persisting a message. If this transaction touched the message
    // table first, that lock stays free for the whole message
    // sweep — a concurrent send can acquire it, read `isActive: true`
    // (still true, since this transaction hasn't reached the conversations
    // UPDATE yet), insert a new active message, and commit, ALL before this
    // transaction finally tombstones the conversation a moment later. The
    // new message then survives as an active row under a now-inactive
    // conversation — exactly the same class of bug the FOR UPDATE guard
    // exists to prevent, just reachable through this transaction's own
    // internal ordering rather than the read-then-write gap that guard
    // already closes (review finding — chatgpt-codex-connector on PR
    // #2299). Acquiring the conversations lock FIRST here means a
    // concurrent send's own FOR UPDATE blocks for this transaction's WHOLE
    // duration, including the message sweep — there is no window left.
    const deletedRow = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(conversations)
        .set({ isActive: false, rev: sql`${conversations.rev} + 1` })
        .where(eq(conversations.id, conversationId))
        .returning();
      // Mirrors `globalConversationRepository.softDeleteConversation`'s
      // pattern, and matches `conversations.isActive`'s own doc comment
      // ("history soft-delete"). Every reader that gates on
      // `conversations.isActive` (agent-sessions-runtime.ts's session
      // listings/caps, the v1/MCP conversations API, the compliance
      // retention purge) previously kept treating a page conversation
      // deleted from History as live forever — including, most concretely,
      // letting the agents console's reopen affordance resurrect one with
      // no messages left.
      // The ONE message write outside message-repository.ts that a real user
      // can trigger, so it goes through the same shared page writer.
      // `agentId` no longer scopes the statement — the conversation id
      // already names one thread, and the page is derived from it.
      await deactivateUnifiedMessagesForConversation(tx, conversationId);
      return row ?? null;
    });
    if (deletedRow) {
      emitConversationLifecycle('deleted', { ...deletedRow, rev: Number(deletedRow.rev) });
    }
    // Whole conversation cleared — any summary is stale; the tombstone also
    // guards against a first compaction that may still be in flight.
    await invalidateCompaction(conversationId, { source: 'page', pageId: agentId });
  },

  /**
   * Soft-delete a conversation by id alone (no page scoping) — the v1/MCP
   * conversations API's delete shape: tombstone the conversations row, then
   * every active message under the conversationId. Same lock-order rationale
   * as softDeleteConversation above (conversations row FIRST). Bumps rev and
   * emits `conversation:deleted`.
   */
  async softDeleteConversationById(conversationId: string): Promise<void> {
    const deletedRow = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(conversations)
        .set({ isActive: false, updatedAt: new Date(), rev: sql`${conversations.rev} + 1` })
        .where(eq(conversations.id, conversationId))
        .returning();
      // Still gated on `type='page'`, and deliberately so even now that the
      // legacy sweep beside it is gone (Phase 4 PR 14). This shape accepts ANY
      // conversation id, including a global one, and for a global conversation
      // this route has NEVER tombstoned messages — the legacy statement it
      // used to run matched nothing there. Dropping the gate would be a
      // behaviour change smuggled in by a write-removal PR; the global leg of
      // this route is its own decision, for its own PR.
      if (row?.type === 'page') {
        await deactivateUnifiedMessagesForConversation(tx, conversationId);
      }
      return row ?? null;
    });
    if (deletedRow) {
      emitConversationLifecycle('deleted', { ...deletedRow, rev: Number(deletedRow.rev) });
    }
  },

  /**
   * Close a conversation OUT of its session's listing (`closedInWorkspaceAt`
   * stamp; never touches history soft-delete). The write, its rev bump, and
   * the `conversation:closed` emission live here so the session runtime's
   * wiring cannot skip any of the three (SSoT §3 clause 1).
   */
  async closeConversationListing(conversationId: string): Promise<'closed' | 'noop'> {
    const [updated] = await db
      .update(conversations)
      .set({ closedInWorkspaceAt: new Date(), updatedAt: new Date(), rev: sql`${conversations.rev} + 1` })
      .where(and(eq(conversations.id, conversationId), isNull(conversations.closedInWorkspaceAt)))
      .returning();
    if (!updated) return 'noop';
    emitConversationLifecycle('closed', { ...updated, rev: Number(updated.rev) });
    return 'closed';
  },

  /** Reopen a closed listing (clear the stamp). Twin of closeConversationListing. */
  async reopenConversationListing(conversationId: string): Promise<'reopened' | 'noop'> {
    const [updated] = await db
      .update(conversations)
      .set({ closedInWorkspaceAt: null, updatedAt: new Date(), rev: sql`${conversations.rev} + 1` })
      .where(and(eq(conversations.id, conversationId), isNotNull(conversations.closedInWorkspaceAt)))
      .returning();
    if (!updated) return 'noop';
    emitConversationLifecycle('reopened', { ...updated, rev: Number(updated.rev) });
    return 'reopened';
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
   * Toggle sharing for a conversation. On UN-share, kicks every non-owner
   * socket out of the `conv:<id>` room (best-effort, alongside the existing
   * revocation-kick sets) — room membership is a delivery optimization; the
   * authoritative fact is this row, re-checked at join time.
   */
  async setConversationShared(
    conversationId: string,
    isShared: boolean,
    triggeredBy?: ConversationEventTriggeredBy,
  ): Promise<void> {
    const [updated] = await db
      .update(conversations)
      .set({ isShared, updatedAt: new Date(), rev: sql`${conversations.rev} + 1` })
      .where(eq(conversations.id, conversationId))
      .returning();
    if (!updated) return;
    emitConversationLifecycle('updated', { ...updated, rev: Number(updated.rev) }, triggeredBy, { isShared });
    if (!isShared) {
      // Evict everyone but the owner from the content room. Best-effort by
      // design (kick-client never throws); join-time authz remains the gate.
      void kickUserFromRooms({
        userId: '*',
        exceptUserId: updated.userId,
        roomPattern: conversationRoom(conversationId),
        reason: 'conversation_unshared',
      }).catch(() => {});
    }
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
          // Rename is a lifecycle mutation → rev bump (fresh inserts start at
          // the column default 0; only the conflict/update leg bumps).
          rev: sql`${conversations.rev} + 1`,
        },
      })
      .returning();

    if (result) {
      emitConversationLifecycle('updated', { ...result, rev: Number(result.rev) }, undefined, { title });
    }
    return result ? { id: result.id, title: result.title } : result;
  },

  /**
   * Auto-title a conversation from its first message, without ever
   * overwriting a title that's already set (including a user's manual
   * rename via upsertConversationTitle). The IS-NULL guard lives in the SQL
   * WHERE clause rather than an in-memory check, so it's safe to call on
   * every message — no separate "is this the first message" lookup needed
   * — and race-safe: two concurrent calls both issue this same guarded
   * UPDATE, and only the one that lands first actually sets a row.
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
