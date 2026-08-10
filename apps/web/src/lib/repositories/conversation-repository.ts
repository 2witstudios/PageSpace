/**
 * Repository for conversation database operations.
 * This seam isolates query-builder details from route handlers,
 * enabling proper unit testing of routes without ORM chain mocking.
 */

import { db } from '@pagespace/db/db'
import { eq, and, ne, sql, inArray, isNull, isNotNull, isDistinctFrom } from '@pagespace/db/operators'
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
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * The rev bump, as a statement fragment — for the LIFECYCLE writes here that
 * cannot use `bumpConversationRev`.
 *
 * Those writes carry guarded WHEREs (`isDistinctFrom`, `isNull(title)`) and
 * `.returning()` the full row, where
 * `bumpConversationRev` matches on id alone; one of them is an upsert. So they
 * stay hand-written, and this at least makes the bump ONE spelling rather than
 * nine copies of `sql`...``.
 *
 * A FUNCTION, not a module constant: building the `sql` template eagerly at
 * import time breaks the ~20 unit suites that mock `@pagespace/db/operators`,
 * for the same reason `unified-message-scope.ts` gives.
 */
const revBump = () => sql`${conversations.rev} + 1`;

/**
 * The slice of a Drizzle client a conversation write needs — satisfied by the
 * pooled `db` and by a transaction alike.
 *
 * It exists so the membership chokepoint can hand its own transaction to the
 * creator: a conversation row and the node that makes it a member of a
 * workspace are one fact, so they are one commit. Type-only, so nothing about
 * the default pooled path changes.
 */
type ConversationWriteExecutor = Pick<typeof db, 'select' | 'insert'>;

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
  executor: ConversationWriteExecutor = db,
): Promise<boolean> {
  // Unified `messages` (Phase 4 / D6). Scoped by conversationId alone, exactly
  // as before — the point of the check is "does this id already hold someone
  // else's messages", which is a question about the id, not about a page.
  //
  // Asked as an existence check rather than by fetching every row and calling
  // `.some()` in JS: the answer is one bit, and a long-lived conversation can
  // hold thousands of rows.
  //
  // `userId IS NOT NULL` is stated EXPLICITLY rather than relied on. Agent-
  // authored rows carry a null `userId`, and SQL's `<>` against NULL yields
  // NULL (not true), so they are excluded either way — but the exclusion is
  // deliberate, and a reader should not have to reconstruct it from three-
  // valued logic.
  const [conflicting] = await executor
    .select({ id: messages.id })
    .from(messages)
    .where(and(
      eq(messages.conversationId, conversationId),
      eq(messages.isActive, true),
      isNotNull(messages.userId),
      ne(messages.userId, userId),
    ))
    .limit(1);
  return conflicting !== undefined;
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
   * load-bearing for session binding: a caller that needed the thread to be
   * admitted into a workspace must know whether its own insert happened.
   * Callers that only need idempotent ensure-exists semantics can ignore the
   * result exactly as before.
   */

  /**
   * The API's conversation creator (`POST /api/v1/conversations`), which is a
   * different animal from `createConversation` below: `type='client'` with a
   * DRIVE in `contextId` (what a drive-scoped MCP token is authorized against),
   * not `type='page'` with a page.
   *
   * It exists so that creator emits too. It was a bare `db.insert` in the
   * route, making it the only one of the three creation paths that announced
   * nothing — routes never decide whether to broadcast (SSoT §3), and a fourth
   * creator appearing later should not have to rediscover that.
   *
   * Emitting costs one broadcast and buys consistency across all three
   * creators — the alternative is a silent exception that the next in-app
   * viewer for API threads would have to find.
   */
  async createApiConversation(values: {
    id: string;
    userId: string;
    title: string | null;
    type: string;
    contextId: string | null;
    updatedAt: Date;
  }): Promise<void> {
    const [inserted] = await db.insert(conversations).values(values).returning();
    if (!inserted) return;
    emitConversationLifecycle('created', { ...inserted, rev: Number(inserted.rev) });
  },

  async createConversation(
    conversationId: string,
    userId: string,
    pageId: string,
    opts?: {
      isShared?: boolean;
      title?: string;
      triggeredBy?: ConversationEventTriggeredBy;
      /**
       * Run every statement on THIS executor rather than the pooled `db`.
       *
       * The membership chokepoint passes the transaction its node write runs
       * in, so a conversation and the node that makes it a member of a
       * workspace commit together or not at all — see
       * `create-conversation-in-workspace.ts`. Everything here is already
       * session-agnostic (there is no `workspaceId` parameter and no column
       * anywhere to write), so the executor is the ONLY thing this option
       * changes.
       */
      executor?: ConversationWriteExecutor;
    }
  ): Promise<'created' | 'exists' | 'message_owner_conflict'> {
    const executor = opts?.executor ?? db;
    const [existing] = await executor
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (existing) return 'exists';

    const hasConflictingOwner = await hasConflictingMessageOwner(conversationId, userId, executor);
    if (hasConflictingOwner) return 'message_owner_conflict';

    // Always session-agnostic: this never writes membership. A conversation
    // that needs a workspace is admitted into one by the membership write —
    // see `create-conversation-in-workspace.ts`.
    const [inserted] = await executor
      .insert(conversations)
      .values({
        id: conversationId,
        userId,
        type: 'page',
        contextId: pageId,
        isShared: opts?.isShared ?? false,
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
   * Bind (or unbind, with `planPageId: null`) this conversation's plan page —
   * the ONE writer of `conversations.planPageId`, and therefore the one place
   * the rev bump and the directory emit can be guaranteed.
   *
   * It was three open-coded `UPDATE conversations SET planPageId` statements
   * (`set_plan`, `clear_plan`, and the plan DELETE route), none of which
   * bumped `rev` or emitted anything, while `planPageId` had no wire
   * representation at all. `PlanChip` renders this column, so the same
   * conversation open in a second pane saw an unchanged rev — indistinguishable
   * from "nothing happened" — and showed no chip, or a stale one after a
   * clear, until a reload. Two panes on one conversation is the epic's
   * headline story, so a lifecycle write that only the acting pane observes is
   * the exact failure this choke point exists to prevent.
   *
   * `userId` rides the WHERE (same shape as `claimConversation`), so ownership
   * is enforced by the write itself rather than by a caller's earlier read —
   * no read-then-write gap.
   *
   * ONLY A REAL CHANGE WRITES, the same discipline `setConversationShared`
   * applies: `isDistinctFrom` is the null-safe inequality, so re-binding the
   * plan a conversation already has (or clearing one that is already clear)
   * matches zero rows and cannot bump `rev` or emit for a change that did not
   * happen. A plain `ne` would be wrong here — `NOT (col = value)` is NULL
   * when the column is NULL, which would skip the null→page transition this
   * guard most needs to allow.
   *
   * `'noop'` therefore means one of: no such row, not the caller's, or already
   * in the requested state. All three are the same answer to the callers,
   * which map it onto their own refusal.
   */
  async setConversationPlan(
    conversationId: string,
    userId: string,
    planPageId: string | null,
    // Optional, and usually absent: the agent tools that drive this have no
    // browser session to echo-suppress against, so every pane — including the
    // one whose turn set the plan — hears it and converges on the same row.
    triggeredBy?: ConversationEventTriggeredBy,
  ): Promise<'set' | 'noop'> {
    const [updated] = await db
      .update(conversations)
      .set({
        planPageId,
        updatedAt: new Date(),
        // Lifecycle mutation → rev bump, same statement (SSoT §3 clause 2).
        rev: revBump(),
      })
      .where(and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId),
        isDistinctFrom(conversations.planPageId, planPageId),
      ))
      .returning();

    if (!updated) return 'noop';
    emitConversationLifecycle(
      'updated',
      { ...updated, rev: Number(updated.rev) },
      triggeredBy,
      { planPageId },
    );
    return 'set';
  },

  /*
   * `claimConversation` USED TO BE HERE, and its deletion is the point of this
   * change rather than a side effect of it. It was the only UPDATE of
   * `conversations.workspaceId` (a column that is itself now gone), carefully
   * guarded (`workspaceId IS NULL AND userId = :caller`) so a binding could
   * never be re-pointed. That guard is not weakened, it is SUPERSEDED:
   * membership is a row in
   * `agent_workspace_nodes`, whose global `UNIQUE (targetId) WHERE targetKind
   * = 'chat'` states "a thread has one workspace" as a database constraint
   * rather than as a WHERE clause a future writer could forget. Nothing in this
   * repository writes membership; `applyWorkspaceMembershipWrite` is the one
   * funnel, and it is a transaction rather than a statement, so the row and its
   * membership can no longer land separately.
   *
   * `closeConversationListing` / `reopenConversationListing` went the same way,
   * for the same reason — see the note where they used to be.
   */

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
        .set({ isActive: false, rev: revBump() })
        .where(eq(conversations.id, conversationId))
        .returning();
      // Mirrors `globalConversationRepository.softDeleteConversation`'s
      // pattern, and matches `conversations.isActive`'s own doc comment
      // ("history soft-delete"). Every reader that gates on
      // `conversations.isActive` (agent-workspaces-runtime.ts's session
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
    //
    // Guarded, and deliberately NOT allowed to fail the call: the delete has
    // already COMMITTED by this point, so an exception here would surface as a
    // 500 for an operation that succeeded — the caller would retry a deletion
    // that already happened. A stale summary is a far smaller problem, and it
    // is self-correcting on the next compaction.
    try {
      await invalidateCompaction(conversationId, { source: 'page', pageId: agentId });
    } catch (error) {
      loggers.api.warn('conversationRepository: compaction invalidation failed after delete', {
        conversationId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
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
        .set({ isActive: false, updatedAt: new Date(), rev: revBump() })
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

  /*
   * `closeConversationListing` / `reopenConversationListing` USED TO BE HERE.
   * They stamped and cleared `conversations.closedInWorkspaceAt` — a column
   * that is itself now gone — which meant
   * "not in the workspace's listing" while a pane row meant "on screen" — two
   * facts about one thread, written by two paths, and the reason a thread could
   * be in a workspace and invisible in it.
   *
   * Closing is now a `destroy` of the thread's node and reopening an
   * admission, both through `applyWorkspaceMembershipWrite`.
   *
   * **Their `conversation:closed` / `conversation:reopened` emits moved WITH
   * them — they were not superseded.** This comment used to claim the
   * structural `workspace:nodes-updated` broadcast covered them, on the
   * reasoning that the fact which changed is the node's location. It does not,
   * and the claim cost a release's worth of staleness: that broadcast carries
   * the TREE, and the sidebar's conversation rows are keyed by the LISTING and
   * never by the tree (`AgentsSidebar.tsx`), into an SWR cache the tree event
   * never touches. So a server-side close removed no row until the 120s
   * backstop poll. The emits now live at the close/reopen chokepoints in
   * `agent-workspaces-runtime.ts`; see `announceClosed` in
   * `close-conversation-in-workspace.ts`.
   */

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
   *
   * Only a REAL change writes and emits; the kick runs on every un-share
   * request regardless, so re-issuing one remains the retry for a kick that
   * did not land. See the two comments in the body for why each half is where
   * it is.
   */
  async setConversationShared(
    conversationId: string,
    isShared: boolean,
    triggeredBy?: ConversationEventTriggeredBy,
  ): Promise<void> {
    // ONLY A REAL CHANGE WRITES. `ne` makes a redundant toggle match no row, so
    // `updated` is undefined and this returns below without bumping `rev` or
    // emitting anything. That is not just tidiness: it is what makes the
    // audience widening on the next line safe. Without it, un-sharing an
    // already-private conversation would announce that conversation's id to
    // every member of the page room — people who may never have been able to
    // see it — which would be a (small) existence leak introduced by the fix
    // for the staleness bug.
    const [updated] = await db
      .update(conversations)
      .set({ isShared, updatedAt: new Date(), rev: revBump() })
      .where(and(eq(conversations.id, conversationId), ne(conversations.isShared, isShared)))
      .returning();
    // THE EVICTION RUNS ON EVERY UN-SHARE REQUEST, INCLUDING ONE THAT CHANGED
    // NOTHING — and therefore ABOVE the `if (!updated) return` below (review
    // finding MINOR 2).
    //
    // The kick is best-effort by construction: `kick-client` never throws and
    // this call swallows. So when a kick is lost (realtime down, HMAC reject,
    // timeout), re-issuing the un-share is the ONLY recovery path there is.
    // Gating it on `updated` took that away — the retry matched no row and
    // returned before kicking, leaving sockets joined to `conv:<id>` receiving
    // content events until they happened to reconnect. An earlier call having
    // *run* the kick is not the same fact as the kick having *landed*, which
    // is what the comment this replaces quietly assumed.
    //
    // It cannot reintroduce the existence leak the `ne` guard prevents: this
    // posts only to `/api/kick` and emits nothing to the page room.
    if (!isShared) {
      // `updated` is absent exactly when the row was already private, so the
      // owner has to come from a read. Without it `exceptUserId` is undefined
      // and `userId: '*'` would evict the OWNER from their own room — a no-op
      // toggle logging its owner out of their own conversation, strictly worse
      // than the staleness being fixed. A PK lookup on the rare redundant path.
      const ownerId =
        updated?.userId ??
        (
          await db
            .select({ userId: conversations.userId })
            .from(conversations)
            .where(eq(conversations.id, conversationId))
            .limit(1)
        )[0]?.userId;

      // No row at all (deleted, or never existed): nobody to except, and
      // `userId: '*'` with no exception would evict indiscriminately.
      if (ownerId) {
        // Evict everyone but the owner from the content room. Join-time authz
        // remains the gate; room membership is only a delivery optimization.
        void kickUserFromRooms({
          userId: '*',
          exceptUserId: ownerId,
          roomPattern: conversationRoom(conversationId),
          reason: 'conversation_unshared',
        }).catch(() => {});
      }
    }
    // Already in the requested state (or no such row): nothing changed, so no
    // event. The eviction above deliberately already ran.
    if (!updated) return;
    // AUDIENCE IS THE UNION OF BEFORE AND AFTER — which, for a toggle that
    // actually flipped, is always "shared".
    //
    // `directoryRoomsFor` adds the page room only when the context says the
    // conversation IS shared, and `updated` is the POST-update row. On an
    // UN-share that reads `false`, so the event would reach the owner's own
    // directory room and nobody else — and the people who need to hear "this
    // is no longer shared" are exactly the collaborators in the page room the
    // post-update flag just excluded. Sharing needs the page room too, so both
    // directions want the same audience, and — because the `ne` above proves
    // the value actually flipped — one side of that union is always `true`.
    //
    // Safe because `isShared` is audience-only: `baseFromContext` never copies
    // it into the payload, and the fact clients act on rides in `changes`
    // below, which still says what actually happened.
    emitConversationLifecycle(
      'updated',
      { ...updated, rev: Number(updated.rev), isShared: true },
      triggeredBy,
      { isShared },
    );
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
          rev: revBump(),
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
      .set({ title, updatedAt: new Date(), rev: revBump() })
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
