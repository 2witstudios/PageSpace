/**
 * MESSAGE REPOSITORY — the one writer for durable chat messages
 * (Agent-Session Single Source of Truth epic, Phase 2; spec
 * docs/2.0-architecture/agent-sessions.md §3 clauses 1–2).
 *
 * Every durable message write — user sends, terminal stream writes, worker
 * dispatch, consult, workflows, v1 completions, ask_user merges, streaming
 * placeholders, the interrupted-stream materializer, edits, deletes, undo —
 * goes through this module. The contract, per write:
 *
 *   1. IN ONE TRANSACTION: the scoped upsert (moved here, private, from
 *      message-utils.ts — nothing can bypass the choke point) PLUS
 *      `UPDATE conversations SET rev = rev + 1, lastMessageAt = now()
 *      RETURNING rev` (conversation-rev.ts).
 *   2. AFTER COMMIT: emit the authoritative event —
 *      `conversation:message_created` / `:message_updated` / `:message_deleted`
 *      / `:undo_applied` to `conv:<id>`, plus a tiny directory
 *      `conversation:updated {lastMessageAt, rev}` — via conversation-events.ts.
 *
 * Routes never decide whether to broadcast: a server-side `send_session`
 * dispatch and a pane's own POST take the same write path and emit the same
 * events. Emission is best-effort (fire-and-forget, logged); correctness
 * comes from the rev watermark + refetch, not delivery.
 *
 * Legacy `chat:*` events: the page-room `chat:user_message` /
 * `chat:stream_*` emissions stay at their existing sites (old clients depend
 * on them; deleted in a later PR). The legacy edit/delete/undo broadcasts
 * moved INTO this module alongside the writes they describe.
 *
 * ── ONE TABLE (Phase 4, D6) ───────────────────────────────────────────────
 * `chat_messages` was merged into `messages` and DROPPED at PR 15 (migration
 * 0253). There is one message table, and this module is its writer: page rows
 * go through the shared page writer (`unified-message-leg.ts`), global rows
 * are written here directly, as they always were, with an explicit
 * `sourceAgentId: null`.
 *
 * ── READER CUTOVER + REPOSITORY MERGE (Phase 4 PR 12, D6) ─────────────────
 * This module is also the one READER for durable chat messages. The whole
 * message surface of `chat-message-repository.ts` (deleted by that PR) and the
 * message-table half of `global-conversation-repository.ts` moved in here, and
 * every one reads the UNIFIED `messages` table.
 *
 * Page scope is `unifiedPageScope()` — see its doc for why a row's page is
 * derived from its conversation rather than stored on the row.
 */

import type { UIMessage } from 'ai';
import { db } from '@pagespace/db/db';
import { eq, and, ne, lt, gte, asc, desc } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { decryptFieldValuesOnce } from '@pagespace/lib/encryption/field-crypto';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { globalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { notifyMentionedUsers } from '@/lib/channels/notify-mentioned-users';
import {
  extractStructuredContentFromParts,
  convertDbMessageToUIMessage,
  MessageConversationConflictError,
  type ToolCall,
  type ToolResult,
} from '@/lib/ai/core/message-utils';
import {
  conversationEvents,
  SERVER_TRIGGERED_BROWSER_SESSION,
  type ConversationEmitContext,
  type ConversationEventTriggeredBy,
} from '@/lib/websocket/conversation-events';
import {
  broadcastAiMessageEdited,
  broadcastAiMessageDeleted,
  broadcastAiUndoApplied,
} from '@/lib/websocket/socket-utils';
import type { TriggeredBy } from '@/lib/websocket/broadcast-triggered-by';
import {
  derivedPageId,
  unifiedPageScope,
} from '@/lib/repositories/unified-message-scope';
import {
  bumpConversationRev,
  emitContextFromRow,
  type BumpedConversationRow,
  type DbExecutor,
} from '@/lib/repositories/conversation-rev';
import {
  upsertUnifiedPageMessage,
  insertUnifiedPageMessage,
  materializeUnifiedPageMessage,
  mutateUnifiedMessageById,
  serializeJsonColumn,
  type UnifiedLegOutcome,
} from '@/lib/repositories/unified-message-leg';

// ---------------------------------------------------------------------------
// Private raw savers — moved verbatim from message-utils.ts (where they were
// exported and ~10 call sites saved directly). Unexported ON PURPOSE: the
// only path to a message write is a repository method that bumps rev and
// emits.
// ---------------------------------------------------------------------------

async function savePageMessageRow({
  messageId,
  pageId,
  conversationId,
  userId,
  role,
  content,
  toolCalls,
  toolResults,
  uiMessage,
  sourceAgentId,
  mentionNotify,
  status = 'complete',
  dbClient,
}: {
  messageId: string;
  pageId: string;
  conversationId: string;
  userId: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  uiMessage?: UIMessage;
  sourceAgentId?: string | null;
  mentionNotify?: { driveId: string; triggeredByUserId: string; mentionerName?: string };
  status?: 'complete' | 'interrupted';
  dbClient: DbExecutor;
}): Promise<void> {
  let structuredContent = content;
  if (uiMessage?.parts && uiMessage.parts.length > 0) {
    structuredContent = await extractStructuredContentFromParts(uiMessage.parts, content);
  }

  const toolCallsJson = serializeJsonColumn(toolCalls);
  const toolResultsJson = serializeJsonColumn(toolResults);
  const createdAt = new Date();

  // The scoped upsert lives in the shared page writer. The gate it carries is
  // inherited verbatim from the legacy statement, and is what `no_match`
  // reports: a
  // client-supplied messageId colliding with a row in a DIFFERENT conversation
  // — ids are one global space — declines the conflict action entirely (no
  // overwrite, no re-parent), and the role half closes same-conversation role
  // spoofing (a 'user' save whose id equals an existing 'assistant' row's).
  const outcome = await upsertUnifiedPageMessage(dbClient, {
    messageId,
    conversationId,
    userId,
    role,
    content: structuredContent,
    toolCallsJson,
    toolResultsJson,
    sourceAgentId: sourceAgentId ?? null,
    status,
    createdAt,
  });

  if (outcome === 'no_match') {
    loggers.ai.warn(
      'messageRepository: client-supplied id collided with a message in a different conversation — rejected',
      { messageId, conversationId, pageId },
    );
    // MUST throw, not just log — a silent return would let callers proceed
    // (lastMessageAt bump, audit rows, mention notifications) as though the
    // message had been persisted. See MessageConversationConflictError's doc.
    throw new MessageConversationConflictError(messageId, conversationId);
  }

  // Fire-and-forget mention notifications for assistant messages only.
  if (mentionNotify && role === 'assistant' && content.trim()) {
    void notifyMentionedUsers({
      content,
      pageId,
      driveId: mentionNotify.driveId,
      triggeredByUserId: mentionNotify.triggeredByUserId,
      mentionerNameOverride: mentionNotify.mentionerName,
    });
  }
}

async function saveGlobalMessageRow({
  messageId,
  conversationId,
  userId,
  role,
  content,
  toolCalls,
  toolResults,
  uiMessage,
  status = 'complete',
  dbClient,
}: {
  messageId: string;
  conversationId: string;
  userId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  uiMessage?: UIMessage;
  status?: 'complete' | 'interrupted';
  dbClient: DbExecutor;
}): Promise<void> {
  let structuredContent = content;
  if (uiMessage?.parts && uiMessage.parts.length > 0) {
    structuredContent = await extractStructuredContentFromParts(uiMessage.parts, content);
  }

  const toolCallsJson = serializeJsonColumn(toolCalls);
  const toolResultsJson = serializeJsonColumn(toolResults);

  // Scoped upsert — see savePageMessageRow's comment; same collision and
  // role-spoofing gates, spelled out here because the global path writes the
  // table directly rather than through the shared page writer.
  //
  // `sourceAgentId` is explicit rather than left to the column default: the
  // attribution rule is a contract, and a global row states its half of it.
  const result = await dbClient
    .insert(messages)
    .values({
      id: messageId,
      conversationId,
      userId,
      role,
      content: structuredContent,
      toolCalls: toolCallsJson,
      toolResults: toolResultsJson,
      createdAt: new Date(),
      isActive: true,
      status,
      // The global assistant is not an agent PAGE, so there is no agent page
      // id to attribute: NULL means "platform-authored, source not recorded",
      // which is exactly the attribution rule's second clause.
      sourceAgentId: null,
    })
    .onConflictDoUpdate({
      target: messages.id,
      set: {
        content: structuredContent,
        toolCalls: toolCallsJson,
        toolResults: toolResultsJson,
        status,
      },
      where: and(eq(messages.conversationId, conversationId), eq(messages.role, role)),
    })
    .returning({ id: messages.id });

  if (result.length === 0) {
    loggers.ai.warn(
      'messageRepository: client-supplied id collided with a message in a different conversation — rejected',
      { messageId, conversationId },
    );
    throw new MessageConversationConflictError(messageId, conversationId);
  }
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/**
 * Runs INSIDE the repository's transaction, BEFORE the message write — the
 * seam for the routes' guarded preludes (the `SELECT ... FOR UPDATE`
 * isActive re-check, the create-the-conversation-in-this-transaction
 * pattern). Return `false` (or `{proceed: false}`) to skip the save cleanly;
 * throw to abort the transaction; `{conversationCreated: true}` tells the
 * repository to emit `conversation:created` after commit.
 */
/**
 * One durable row of the unified `messages` table, as the read seam returns
 * it. Structurally the useful subset of the former `ChatMessage`
 * (chat-message-repository) minus its `pageId` column — a row's page is its
 * CONVERSATION's page now — so the OpenAI-shaped serializers accept it
 * unchanged.
 */
export interface UnifiedMessageRow {
  id: string;
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
  status: 'streaming' | 'complete' | 'interrupted';
}

/**
 * A page-chat row plus the page it belongs to, derived at read time. Returned
 * by the readers whose callers need the page for a permission check
 * (`checkMCPPageScope`, `canPrincipalEditPage`) — historically
 * `chat_messages.pageId`, now derived (`derivedPageId`).
 */
export interface UnifiedPageMessageRow extends UnifiedMessageRow {
  /**
   * `conversations.contextId` for a `type='page'` conversation,
   * `conversations.agentPageId` for a `type='client'` one (see
   * `derivedPageId`). Null when the row names no page at all — a
   * global-assistant message, or an API thread that has not run a completion.
   */
  pageId: string | null;
}

/** A page-chat row with its author's display fields, for client-facing history. */
export interface UnifiedPageMessageWithAuthor extends UnifiedPageMessageRow {
  userName?: string | null;
  userImage?: string | null;
}

/** The column list every unified reader selects. Kept in one place so the shapes cannot drift. */
const unifiedColumns = {
  id: messages.id,
  conversationId: messages.conversationId,
  userId: messages.userId,
  role: messages.role,
  content: messages.content,
  messageType: messages.messageType,
  isActive: messages.isActive,
  createdAt: messages.createdAt,
  editedAt: messages.editedAt,
  toolCalls: messages.toolCalls,
  toolResults: messages.toolResults,
  status: messages.status,
} as const;

export type BeforeSaveHook = (
  tx: DbExecutor,
) => Promise<void | boolean | { proceed: boolean; conversationCreated?: boolean }>;

export interface MessageWriteResult {
  /** False when a beforeSave hook skipped the write (e.g. history-deleted conversation). */
  saved: boolean;
  /** Post-write rev; 0 when the conversation has no row (legacy page conversations). */
  rev: number;
}

const serverTriggered = (userId: string): ConversationEventTriggeredBy => ({
  userId,
  browserSessionId: SERVER_TRIGGERED_BROWSER_SESSION,
});

/** Minimal UIMessage for events when the caller has no full UIMessage. */
const buildEventMessage = (args: {
  messageId: string;
  role: string;
  content: string;
  uiMessage?: UIMessage;
  status: string;
}): UIMessage & { status?: string; createdAt?: Date } => {
  if (args.uiMessage) {
    return {
      ...(args.uiMessage as UIMessage),
      id: args.messageId,
      status: args.status,
      createdAt: new Date(),
    } as UIMessage & { status?: string; createdAt?: Date };
  }
  return {
    id: args.messageId,
    role: args.role,
    parts: [{ type: 'text', text: args.content }],
    status: args.status,
    createdAt: new Date(),
  } as unknown as UIMessage & { status?: string; createdAt?: Date };
};

const normalizeHook = async (
  tx: DbExecutor,
  hook: BeforeSaveHook | undefined,
): Promise<{ proceed: boolean; conversationCreated: boolean }> => {
  if (!hook) return { proceed: true, conversationCreated: false };
  const res = await hook(tx);
  if (res === false) return { proceed: false, conversationCreated: false };
  if (typeof res === 'object' && res !== null) {
    return { proceed: res.proceed, conversationCreated: res.conversationCreated === true };
  }
  return { proceed: true, conversationCreated: false };
};

/** Post-commit emission shared by the save paths. Best-effort, never throws. */
const emitAfterSave = (args: {
  row: BumpedConversationRow | null;
  fallbackCtx: ConversationEmitContext;
  existed: boolean;
  conversationCreated: boolean;
  eventMessage: UIMessage & { status?: string; createdAt?: Date };
}): void => {
  const ctx = args.row ? emitContextFromRow(args.row, args.fallbackCtx.triggeredBy) : args.fallbackCtx;
  const lastMessageAt = args.row?.lastMessageAt ?? null;
  void (async () => {
    if (args.conversationCreated && args.row) {
      await conversationEvents.created(ctx, {
        id: args.row.id,
        title: args.row.title,
        type: args.row.type,
        contextId: args.row.contextId,
        workspaceId: args.row.workspaceId,
        isShared: args.row.isShared,
        createdAt: args.row.createdAt.toISOString(),
        lastMessageAt: lastMessageAt ? lastMessageAt.toISOString() : null,
      });
    }
    const emit = args.existed ? conversationEvents.messageUpdated : conversationEvents.messageCreated;
    await emit.call(conversationEvents, ctx, args.eventMessage, lastMessageAt, {
      // No conversations row → owner unknown → no directory room to target.
      skipDirectory: args.row === null,
    });
  })().catch((error) => {
    loggers.ai.warn('messageRepository: post-commit event emission failed', {
      conversationId: ctx.conversationId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  });
};

/**
 * Emit context for the mutation paths (edit/delete/undo/placeholder/
 * materialize). Module-level rather than a `this.`-method: `this` inside an
 * object literal breaks the moment any caller destructures a method off the
 * repository (same rationale as conversation-repository.ts).
 */
function contextForMutation(
  row: BumpedConversationRow | null,
  conversationId: string,
  fallbackScope: ConversationEmitContext['scope'],
  triggeredBy: { userId: string; browserSessionId: string },
): ConversationEmitContext {
  const slim = { userId: triggeredBy.userId, browserSessionId: triggeredBy.browserSessionId };
  if (row) return emitContextFromRow(row, slim);
  return {
    conversationId,
    rev: 0,
    scope: fallbackScope,
    workspaceId: null,
    ownerId: triggeredBy.userId,
    isShared: false,
    triggeredBy: slim,
  };
}

/**
 * What an id-scoped edit/delete did, and the conversation row to emit from.
 *
 * `no_match` is the gate `mutateUnifiedMessageById` already reported and every
 * caller here used to discard. Post-merge there is one message table, so an
 * UPDATE matching nothing means the id names no row — the caller must NOT bump
 * the rev or broadcast. `syncWatchedConversationRevs` compares revs and nothing
 * else, so a bump is an instruction to every open pane to refetch; doing that
 * for a write that changed nothing is pure churn, and the accompanying
 * `message_updated` / `message_deleted` describes a message that does not
 * exist.
 *
 * The routes read the message before calling, so this should be unreachable —
 * which is exactly why it is logged at `warn` rather than swallowed. If it
 * fires, something upstream is wrong.
 */
type WriteResult = { outcome: UnifiedLegOutcome; row: BumpedConversationRow | null };

/** Report an id-scoped write that matched nothing. Loud, not swallowed — see `WriteResult`. */
function warnNoMatch(method: string, args: { messageId: string; conversationId: string }): void {
  loggers.api.warn('messageRepository: write matched no row — no rev bump, no broadcast', {
    method,
    messageId: args.messageId,
    conversationId: args.conversationId,
  });
}

/**
 * THE DELETE PATHS' WRITE: tombstone message rows, recompute the conversation's
 * `lastMessageAt` from what survives, and bump the rev — all in ONE transaction,
 * one statement for the last two.
 *
 * `recomputeLastMessageAt` below states the contract every delete path is
 * supposed to honour ("soft-delete, hard-delete, purge, and the interrupted-
 * stream materializer"). Only the global delete actually did, and it did it in a
 * SECOND transaction after the first had committed, with the failure swallowed
 * to a warn — so a crash in the gap left the conversation sorted on a tombstoned
 * row forever, with no repair path. The page delete and the undo range never
 * recomputed at all: deleting the newest message in a page conversation left
 * `lastMessageAt` pointing at a row that is no longer active.
 *
 * ORDER MATTERS. The conversation row is locked FIRST — before the message write
 * and before the read that decides the new sort key. Without the lock a
 * concurrent writer (a normal message save, or another delete's recompute) can
 * commit between this function's SELECT and its UPDATE, and this UPDATE then
 * overwrites that writer's fresher timestamp with a stale snapshot. Locking
 * conversations before messages is also the order `softDeleteConversation` and
 * the chat-turn's user-message save already take, so this introduces no new
 * deadlock ordering.
 *
 * A `no_match` tombstone means the message id named nothing (an id-scoped
 * delete) — see `WriteResult`. The recompute and the bump are then SKIPPED:
 * bumping the rev for a write that changed no row tells every subscriber to
 * refetch a conversation that did not move.
 *
 * Returns the bumped row (the rev + the recomputed timestamp the post-commit
 * emission carries), or null for a conversation with no `conversations` row.
 */
async function tombstoneAndRebump(
  tx: DbExecutor,
  conversationId: string,
  tombstone: (tx: DbExecutor) => Promise<UnifiedLegOutcome>,
): Promise<WriteResult> {
  await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for('update');

  if ((await tombstone(tx)) === 'no_match') return { outcome: 'no_match', row: null };

  const [newest] = await tx
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(and(
      eq(messages.conversationId, conversationId),
      eq(messages.isActive, true),
    ))
    .orderBy(desc(messages.createdAt))
    .limit(1);

  const row = await bumpConversationRev(tx, conversationId, {
    extraSet: { lastMessageAt: newest ? newest.createdAt : null },
  });
  return { outcome: 'written', row };
}

/** Shared 'streaming'-placeholder emission (message_created with an empty streaming shell). */
function emitPlaceholderCreated(
  row: BumpedConversationRow | null,
  args: { messageId: string; conversationId: string; triggeredBy?: ConversationEventTriggeredBy },
  fallbackScope: ConversationEmitContext['scope'],
): void {
  const triggeredBy = args.triggeredBy ?? serverTriggered(row?.userId ?? 'server');
  const ctx = contextForMutation(row, args.conversationId, fallbackScope, triggeredBy);
  void conversationEvents
    .messageCreated(
      ctx,
      buildEventMessage({
        messageId: args.messageId,
        role: 'assistant',
        content: '',
        status: 'streaming',
      }),
      row?.lastMessageAt ?? null,
      { skipDirectory: row === null },
    )
    .catch(() => {});
}

/** Shared materializer emission (a terminal write by another door → message_updated). */
function emitMaterialized(
  row: BumpedConversationRow | null,
  args: { messageId: string; conversationId: string; eventMessage?: UIMessage },
  fallbackScope: ConversationEmitContext['scope'],
): void {
  const triggeredBy = serverTriggered(row?.userId ?? 'server');
  const ctx = contextForMutation(row, args.conversationId, fallbackScope, triggeredBy);
  void conversationEvents
    .messageUpdated(
      ctx,
      buildEventMessage({
        messageId: args.messageId,
        role: 'assistant',
        content: '',
        uiMessage: args.eventMessage,
        status: 'interrupted',
      }),
      row?.lastMessageAt ?? null,
      { skipDirectory: row === null },
    )
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

export const messageRepository = {
  /**
   * Durable save (insert or terminal upsert) of a page-agent chat message.
   * Absorbs every former `saveMessageToDatabase` call site.
   */
  async savePageMessage(args: {
    messageId: string;
    pageId: string;
    conversationId: string;
    userId: string | null;
    role: 'user' | 'assistant' | 'system';
    content: string;
    toolCalls?: ToolCall[];
    toolResults?: ToolResult[];
    uiMessage?: UIMessage;
    sourceAgentId?: string | null;
    mentionNotify?: { driveId: string; triggeredByUserId: string; mentionerName?: string };
    status?: 'complete' | 'interrupted';
    triggeredBy?: ConversationEventTriggeredBy;
    beforeSave?: BeforeSaveHook;
  }): Promise<MessageWriteResult> {
    const outcome = await db.transaction(async (tx) => {
      const hook = await normalizeHook(tx, args.beforeSave);
      if (!hook.proceed) return null;
      const [existing] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.id, args.messageId))
        .limit(1);
      await savePageMessageRow({ ...args, dbClient: tx });
      const row = await bumpConversationRev(tx, args.conversationId, {
        touchLastMessageAt: new Date(),
      });
      return { row, existed: existing !== undefined, conversationCreated: hook.conversationCreated };
    });
    if (!outcome) return { saved: false, rev: 0 };

    const triggeredBy = args.triggeredBy ?? serverTriggered(args.userId ?? outcome.row?.userId ?? 'server');
    emitAfterSave({
      row: outcome.row,
      existed: outcome.existed,
      conversationCreated: outcome.conversationCreated,
      eventMessage: buildEventMessage({
        messageId: args.messageId,
        role: args.role,
        content: args.content,
        uiMessage: args.uiMessage,
        status: args.status ?? 'complete',
      }),
      fallbackCtx: {
        conversationId: args.conversationId,
        rev: outcome.row?.rev ?? 0,
        scope: { kind: 'page', pageId: args.pageId },
        workspaceId: outcome.row?.workspaceId ?? null,
        ownerId: outcome.row?.userId ?? triggeredBy.userId,
        isShared: outcome.row?.isShared ?? false,
        triggeredBy,
      },
    });
    return { saved: true, rev: outcome.row?.rev ?? 0 };
  },

  /**
   * Durable save of a global-assistant message. Absorbs every former
   * `saveGlobalAssistantMessageToDatabase` call site.
   */
  async saveGlobalMessage(args: {
    messageId: string;
    conversationId: string;
    userId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    toolCalls?: ToolCall[];
    toolResults?: ToolResult[];
    uiMessage?: UIMessage;
    status?: 'complete' | 'interrupted';
    triggeredBy?: ConversationEventTriggeredBy;
    beforeSave?: BeforeSaveHook;
  }): Promise<MessageWriteResult> {
    const outcome = await db.transaction(async (tx) => {
      const hook = await normalizeHook(tx, args.beforeSave);
      if (!hook.proceed) return null;
      const [existing] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.id, args.messageId))
        .limit(1);
      await saveGlobalMessageRow({ ...args, dbClient: tx });
      const row = await bumpConversationRev(tx, args.conversationId, {
        touchLastMessageAt: new Date(),
      });
      return { row, existed: existing !== undefined, conversationCreated: hook.conversationCreated };
    });
    if (!outcome) return { saved: false, rev: 0 };

    const triggeredBy = args.triggeredBy ?? serverTriggered(args.userId);
    emitAfterSave({
      row: outcome.row,
      existed: outcome.existed,
      conversationCreated: outcome.conversationCreated,
      eventMessage: buildEventMessage({
        messageId: args.messageId,
        role: args.role,
        content: args.content,
        uiMessage: args.uiMessage,
        status: args.status ?? 'complete',
      }),
      fallbackCtx: {
        conversationId: args.conversationId,
        rev: outcome.row?.rev ?? 0,
        scope: { kind: 'global', ownerId: outcome.row?.userId ?? args.userId },
        workspaceId: outcome.row?.workspaceId ?? null,
        ownerId: outcome.row?.userId ?? args.userId,
        isShared: outcome.row?.isShared ?? false,
        triggeredBy,
      },
    });
    return { saved: true, rev: outcome.row?.rev ?? 0 };
  },

  /**
   * The 'streaming' placeholder row a page-agent generation plants at stream
   * start. Bakes in the route's atomic isActive re-check (`FOR UPDATE`): an
   * EXPLICITLY inactive conversation skips the insert.
   *
   * An ABSENT conversations row used to be "tolerated" here (the eager
   * createConversation call is best-effort — see the route's review history on
   * PR #2299). It no longer can be, and has not really been since migration
   * 0249 gave BOTH message tables an enforced FK to `conversations`: the
   * INSERT below raises 23503 and the transaction aborts. That is the honest
   * outcome — a placeholder under no conversation is a row no reader can ever
   * reach.
   */
  async insertPageStreamingPlaceholder(args: {
    messageId: string;
    pageId: string;
    conversationId: string;
    triggeredBy?: ConversationEventTriggeredBy;
  }): Promise<{ inserted: boolean }> {
    const outcome = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ isActive: conversations.isActive })
        .from(conversations)
        .where(eq(conversations.id, args.conversationId))
        .for('update')
        .limit(1);
      if (row && !row.isActive) return null;
      await insertUnifiedPageMessage(tx, {
        messageId: args.messageId,
        conversationId: args.conversationId,
        userId: null,
        role: 'assistant',
        content: '',
        toolCallsJson: null,
        toolResultsJson: null,
        sourceAgentId: null,
        status: 'streaming',
      });
      // No lastMessageAt touch: 'streaming' rows are excluded from listings.
      const bumped = await bumpConversationRev(tx, args.conversationId);
      return { bumped };
    });
    if (!outcome) return { inserted: false };
    emitPlaceholderCreated(outcome.bumped, args, { kind: 'page', pageId: args.pageId });
    return { inserted: true };
  },

  /** Global twin of insertPageStreamingPlaceholder — absent row SKIPS (matches the global route's stricter guard). */
  async insertGlobalStreamingPlaceholder(args: {
    messageId: string;
    conversationId: string;
    userId: string;
    triggeredBy?: ConversationEventTriggeredBy;
  }): Promise<{ inserted: boolean }> {
    const outcome = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ isActive: conversations.isActive })
        .from(conversations)
        .where(eq(conversations.id, args.conversationId))
        .for('update')
        .limit(1);
      if (!row?.isActive) return null;
      await tx.insert(messages).values({
        id: args.messageId,
        conversationId: args.conversationId,
        userId: args.userId,
        role: 'assistant',
        content: '',
        toolCalls: null,
        toolResults: null,
        isActive: true,
        status: 'streaming',
        // Global leg — see saveGlobalMessageRow for why this is explicit.
        sourceAgentId: null,
      });
      const bumped = await bumpConversationRev(tx, args.conversationId);
      return { bumped };
    });
    if (!outcome) return { inserted: false };
    emitPlaceholderCreated(outcome.bumped, args, {
      kind: 'global',
      ownerId: outcome.bumped?.userId ?? args.userId,
    });
    return { inserted: true };
  },

  /**
   * The interrupted-stream materializer's CAS terminal write for a page-chat
   * row (#2022 invariant: only a row still 'streaming' may be relabelled;
   * `setWhere` keeps the guard atomic). Returns whether the write landed.
   */
  async materializePageInterruptedMessage(args: {
    messageId: string;
    pageId: string;
    conversationId: string;
    structuredContent: string;
    toolCallsJson: string | null;
    toolResultsJson: string | null;
    createdAt: Date;
    eventMessage?: UIMessage;
  }): Promise<boolean> {
    const outcome = await db.transaction(async (tx) => {
      // The CAS (`setWhere status = 'streaming'`) now lives in the shared page
      // writer and is what decides this method's return value: a row already
      // terminal is left alone and reported as not-written, exactly as the
      // legacy statement that used to hold the guard did.
      const written = await materializeUnifiedPageMessage(tx, {
        messageId: args.messageId,
        conversationId: args.conversationId,
        userId: null,
        role: 'assistant',
        content: args.structuredContent,
        toolCallsJson: args.toolCallsJson,
        toolResultsJson: args.toolResultsJson,
        sourceAgentId: null,
        status: 'interrupted',
        createdAt: args.createdAt,
      });
      if (written === 'no_match') return null;
      const row = await bumpConversationRev(tx, args.conversationId, {
        touchLastMessageAt: new Date(),
      });
      return { row };
    });
    if (!outcome) return false;
    emitMaterialized(outcome.row, args, { kind: 'page', pageId: args.pageId });
    return true;
  },

  /** Global twin of materializePageInterruptedMessage. */
  async materializeGlobalInterruptedMessage(args: {
    messageId: string;
    conversationId: string;
    userId: string;
    structuredContent: string;
    toolCallsJson: string | null;
    toolResultsJson: string | null;
    createdAt: Date;
    eventMessage?: UIMessage;
  }): Promise<boolean> {
    const outcome = await db.transaction(async (tx) => {
      const written = await tx
        .insert(messages)
        .values({
          id: args.messageId,
          conversationId: args.conversationId,
          userId: args.userId,
          role: 'assistant',
          content: args.structuredContent,
          toolCalls: args.toolCallsJson,
          toolResults: args.toolResultsJson,
          createdAt: args.createdAt,
          isActive: true,
          status: 'interrupted',
          // Global leg — see saveGlobalMessageRow for why this is explicit.
          sourceAgentId: null,
        })
        .onConflictDoUpdate({
          target: messages.id,
          set: {
            content: args.structuredContent,
            toolCalls: args.toolCallsJson,
            toolResults: args.toolResultsJson,
            conversationId: args.conversationId,
            status: 'interrupted',
          },
          setWhere: eq(messages.status, 'streaming'),
        })
        .returning({ id: messages.id });
      if (written.length === 0) return null;
      const row = await bumpConversationRev(tx, args.conversationId, {
        touchLastMessageAt: new Date(),
      });
      return { row };
    });
    if (!outcome) return false;
    emitMaterialized(outcome.row, args, {
      kind: 'global',
      ownerId: outcome.row?.userId ?? args.userId,
    });
    return true;
  },

  /**
   * Edit a page-chat message's content. Owns the write, the rev bump, the
   * legacy `chat:message_edited` broadcast (moved in from the route), and
   * the authoritative `conversation:message_updated`.
   */
  async editPageMessage(args: {
    messageId: string;
    pageId: string;
    conversationId: string;
    updatedContent: string;
    legacyTriggeredBy: TriggeredBy;
  }): Promise<void> {
    const { outcome, row } = await db.transaction(async (tx): Promise<WriteResult> => {
      const editedAt = new Date();
      const written = await mutateUnifiedMessageById(tx, args.messageId, {
        content: args.updatedContent,
        editedAt,
      });
      if (written === 'no_match') return { outcome: 'no_match', row: null };
      return { outcome: 'written', row: await bumpConversationRev(tx, args.conversationId) };
    });
    if (outcome === 'no_match') return warnNoMatch('editPageMessage', args);

    void (async () => {
      const updated = await messageRepository.getMessageById(args.messageId);
      if (!updated) return;
      const uiMessage = await convertDbMessageToUIMessage(updated);
      await broadcastAiMessageEdited({
        messageId: args.messageId,
        pageId: args.pageId,
        conversationId: args.conversationId,
        parts: uiMessage.parts,
        editedAt: (updated.editedAt ?? new Date()).toISOString(),
        triggeredBy: args.legacyTriggeredBy,
      });
      const ctx = contextForMutation(row, args.conversationId, { kind: 'page', pageId: args.pageId }, args.legacyTriggeredBy);
      await conversationEvents.messageUpdated(
        ctx,
        { ...uiMessage, id: args.messageId } as UIMessage,
        row?.lastMessageAt ?? null,
        { skipDirectory: row === null },
      );
    })().catch((error) => {
      loggers.api.error('messageRepository: edit broadcast failed', error as Error, {
        messageId: args.messageId,
      });
    });
  },

  /** Soft-delete a page-chat message; owns the legacy + authoritative broadcasts. */
  async softDeletePageMessage(args: {
    messageId: string;
    pageId: string;
    conversationId: string;
    legacyTriggeredBy: TriggeredBy;
  }): Promise<void> {
    const { outcome, row } = await db.transaction(async (tx) =>
      tombstoneAndRebump(tx, args.conversationId, (t) =>
        mutateUnifiedMessageById(t, args.messageId, { isActive: false }),
      ),
    );
    if (outcome === 'no_match') return warnNoMatch('softDeletePageMessage', args);

    void (async () => {
      await broadcastAiMessageDeleted({
        messageId: args.messageId,
        pageId: args.pageId,
        conversationId: args.conversationId,
        triggeredBy: args.legacyTriggeredBy,
      });
      const ctx = contextForMutation(row, args.conversationId, { kind: 'page', pageId: args.pageId }, args.legacyTriggeredBy);
      await conversationEvents.messageDeleted(ctx, args.messageId, row?.lastMessageAt ?? null, { skipDirectory: row === null });
    })().catch((error) => {
      loggers.api.error('messageRepository: delete broadcast failed', error as Error, {
        messageId: args.messageId,
      });
    });
  },

  /**
   * Edit a global-assistant message. Legacy broadcast targets the owner's
   * `user:<id>:global` channel exactly as the route did.
   */
  async editGlobalMessage(args: {
    messageId: string;
    conversationId: string;
    ownerUserId: string;
    updatedContent: string;
    legacyTriggeredBy: TriggeredBy;
  }): Promise<void> {
    // Through the shared statement rather than a bare `tx.update`, so the
    // global edit reports `no_match` the same way its page twin does.
    const { outcome, row } = await db.transaction(async (tx): Promise<WriteResult> => {
      const written = await mutateUnifiedMessageById(tx, args.messageId, {
        content: args.updatedContent,
        editedAt: new Date(),
      });
      if (written === 'no_match') return { outcome: 'no_match', row: null };
      return { outcome: 'written', row: await bumpConversationRev(tx, args.conversationId) };
    });
    if (outcome === 'no_match') return warnNoMatch('editGlobalMessage', args);

    void (async () => {
      await broadcastAiMessageEdited({
        messageId: args.messageId,
        pageId: globalChannelId(args.ownerUserId),
        conversationId: args.conversationId,
        parts: [{ type: 'text', text: args.updatedContent }],
        editedAt: new Date().toISOString(),
        triggeredBy: args.legacyTriggeredBy,
      });
      const ctx = contextForMutation(
        row,
        args.conversationId,
        { kind: 'global', ownerId: args.ownerUserId },
        args.legacyTriggeredBy,
      );
      // Mirrors the legacy broadcast's own payload: plain text parts from the
      // updated content (the global edit route never refetched/reconstructed).
      await conversationEvents.messageUpdated(
        ctx,
        buildEventMessage({
          messageId: args.messageId,
          role: 'assistant',
          content: args.updatedContent,
          status: 'complete',
        }),
        row?.lastMessageAt ?? null,
        { skipDirectory: row === null },
      );
    })().catch((error) => {
      loggers.api.error('messageRepository: global edit broadcast failed', error as Error, {
        messageId: args.messageId,
      });
    });
  },

  /**
   * Soft-delete a global-assistant message. The `lastMessageAt` recompute
   * (#2153 — the newest SURVIVING message decides the sort key, not "now") used
   * to run here in a second transaction after this one committed, with its
   * failure swallowed to a warn; it now rides inside the write. See
   * `tombstoneAndRebump`.
   */
  async softDeleteGlobalMessage(args: {
    messageId: string;
    conversationId: string;
    ownerUserId: string;
    legacyTriggeredBy: TriggeredBy;
  }): Promise<void> {
    const { outcome, row } = await db.transaction(async (tx) =>
      tombstoneAndRebump(tx, args.conversationId, (t) =>
        mutateUnifiedMessageById(t, args.messageId, { isActive: false }),
      ),
    );
    if (outcome === 'no_match') return warnNoMatch('softDeleteGlobalMessage', args);

    void (async () => {
      await broadcastAiMessageDeleted({
        messageId: args.messageId,
        pageId: globalChannelId(args.ownerUserId),
        conversationId: args.conversationId,
        triggeredBy: args.legacyTriggeredBy,
      });
      const ctx = contextForMutation(
        row,
        args.conversationId,
        { kind: 'global', ownerId: args.ownerUserId },
        args.legacyTriggeredBy,
      );
      await conversationEvents.messageDeleted(ctx, args.messageId, row?.lastMessageAt ?? null, { skipDirectory: row === null });
    })().catch((error) => {
      loggers.api.error('messageRepository: global delete broadcast failed', error as Error, {
        messageId: args.messageId,
      });
    });
  },

  /**
   * UNDO'S MESSAGE WRITE — soft-delete the undone range AND bump the rev, on
   * the CALLER's transaction, in one statement pair. The choke point for undo,
   * exactly as `editGlobalMessage` / `softDeleteGlobalMessage` are for theirs.
   *
   * Runs on `tx` rather than opening its own, because `executeAiUndo` wraps
   * the activity rollbacks and this deletion in one all-or-nothing transaction
   * — the rev must move with THAT transaction, so a failed rollback takes the
   * bump with it and no event ever describes an uncommitted write.
   *
   * This used to be a bare `tx.update(messages)` in the services layer with
   * the bump arriving later, post-commit, in a separate transaction, from a
   * fire-and-forget block in the route. Any failure in that block committed
   * the write with no rev bump — and since `syncWatchedConversationRevs`
   * compares revs and nothing else, an unbumped rev is indistinguishable from
   * "nothing changed", so every open pane stayed stale until a manual reload
   * with no path to heal.
   *
   * Excludes `status: 'streaming'` rows, mirroring `previewAiUndo`'s
   * affected-message query — the mutation and its preview must agree on scope.
   *
   * Returns the bumped conversation row (the rev the post-commit emission
   * carries), or null for a conversation that no longer exists.
   */
  async softDeleteUndoRange(
    tx: DbExecutor,
    args: { conversationId: string; fromCreatedAt: Date },
  ): Promise<BumpedConversationRow | null> {
    const { row } = await tombstoneAndRebump(tx, args.conversationId, async (t) => {
      await t
        .update(messages)
        .set({ isActive: false })
        .where(and(
          eq(messages.conversationId, args.conversationId),
          gte(messages.createdAt, args.fromCreatedAt),
          eq(messages.isActive, true),
          ne(messages.status, 'streaming'),
        ));
      // Always 'written': this is a RANGE, not an id, so matching zero rows is
      // a legitimate outcome (an idempotent re-undo), not a bad reference. The
      // caller short-circuits on an empty preview before reaching here anyway.
      return 'written';
    });
    return row;
  },

  /**
   * POST-COMMIT emission for an executed undo: the legacy `chat:undo_applied`
   * (moved in from the undo route) plus the authoritative
   * `conversation:undo_applied`, both carrying the rev that
   * `softDeleteUndoRange` already bumped inside the write transaction.
   *
   * Takes that bumped row rather than bumping again — the counter is the
   * write's business, this is only delivery. Fire-and-forget and logged on
   * failure, like every other emission in this module: a committed write must
   * not un-succeed because a broadcast failed, and the rev watermark is what
   * makes a dropped event survivable.
   */
  emitUndoApplied(args: {
    conversationId: string;
    /** The row bumped in the write transaction; null when the conversation is gone. */
    bumped: BumpedConversationRow | null;
    /** The legacy broadcast channel: the pageId for page chat, `user:<id>:global` otherwise. */
    legacyChannelId: string;
    scope: ConversationEmitContext['scope'];
    mode: 'messages_only' | 'messages_and_changes';
    affectedMessageIds: string[];
    legacyTriggeredBy: TriggeredBy;
  }): void {
    void (async () => {
      await broadcastAiUndoApplied({
        conversationId: args.conversationId,
        pageId: args.legacyChannelId,
        mode: args.mode,
        affectedMessageIds: args.affectedMessageIds,
        triggeredBy: args.legacyTriggeredBy,
      });
      const ctx = contextForMutation(args.bumped, args.conversationId, args.scope, args.legacyTriggeredBy);
      await conversationEvents.undoApplied(
        ctx,
        { mode: args.mode, affectedMessageIds: args.affectedMessageIds },
        args.bumped?.lastMessageAt ?? null,
        { skipDirectory: args.bumped === null },
      );
    })().catch((error) => {
      loggers.api.error('messageRepository: undo-applied broadcast failed', error as Error, {
        conversationId: args.conversationId,
      });
    });
  },

  /**
   * Every durable row of one conversation, oldest first — read from the
   * UNIFIED `messages` table (epic "Agent-Session Single Source of Truth",
   * Phase 4 / D6, reader cutover).
   *
   * Replaced `chatMessageRepository.getMessagesByConversationId` outright —
   * that repository is deleted as of this PR. Deliberately scoped by
   * `conversationId` ALONE, exactly as the legacy query was: a conversation id
   * is a cuid2, so it already names one thread, and the page (when there is
   * one) is `conversations.contextId`, not a second key this reader has to
   * carry. That also makes the shape type-agnostic — a `type: 'client'`
   * conversation, whose rows can name a different agent page per row, reads
   * correctly here for the same reason it did before.
   *
   * `includeStreaming` mirrors the legacy default: mid-flight placeholders are
   * hidden unless a caller explicitly opts in.
   */
  async getMessagesByConversationId(
    conversationId: string,
    includeStreaming = false,
  ): Promise<UnifiedMessageRow[]> {
    return db
      .select(unifiedColumns)
      .from(messages)
      .where(and(
        eq(messages.conversationId, conversationId),
        eq(messages.isActive, true),
        ...(includeStreaming ? [] : [ne(messages.status, 'streaming')]),
      ))
      .orderBy(asc(messages.createdAt), asc(messages.id));
  },

  /**
   * A page's chat history, optionally narrowed to one conversation, with the
   * author's display fields joined on — the client-facing history read
   * (`GET /api/ai/chat/messages`) and the OpenAI-compatible route's thread
   * mode. The unified replacement for
   * `chatMessageRepository.getMessagesForPage`.
   *
   * The `pageId` argument stays a real scope, not decoration: the v1 route
   * pairs a caller-supplied conversationId with a page the caller has already
   * been authorized for, and it is that pairing which stops a supplied id from
   * another page's thread reading through.
   */
  async getMessagesForPage(
    pageId: string,
    conversationId?: string,
    includeStreaming = false,
  ): Promise<UnifiedPageMessageWithAuthor[]> {
    const rows = await db
      .select({
        ...unifiedColumns,
        pageId: derivedPageId(),
        userName: users.name,
        userImage: users.image,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .leftJoin(users, eq(messages.userId, users.id))
      .where(and(
        unifiedPageScope(pageId),
        eq(messages.isActive, true),
        ...(conversationId ? [eq(messages.conversationId, conversationId)] : []),
        ...(includeStreaming ? [] : [ne(messages.status, 'streaming')]),
      ))
      .orderBy(asc(messages.createdAt), asc(messages.id));

    // Decrypt PII at the edge (GDPR #965) so the message author name is
    // plaintext. Batched: a page chat is mostly two or three authors repeating
    // across every row, so decrypting per row did N decryptions for a handful
    // of distinct ciphertexts. `decryptFieldValuesOnce` does each once and
    // returns a lookup — fail-closed to null for anything it was not given,
    // matching `decryptField(null)`'s own answer.
    const authorName = await decryptFieldValuesOnce(rows.map((m) => m.userName));
    return rows.map((m) => ({ ...m, userName: authorName(m.userName) })) as UnifiedPageMessageWithAuthor[];
  },

  /**
   * One page conversation's durable history, oldest first, WITHOUT the author
   * join — the model-context load behind the page chat route and the consult
   * route. Same rows as `getMessagesForPage(pageId, conversationId)`; the
   * author's name and avatar are pure cost for a read that only ever feeds a
   * model.
   *
   * Keeps the page predicate rather than scoping by conversationId alone. The
   * chat route's write gate now applies this exact `unifiedPageScope` rule
   * before reaching here (page-chat-turn.ts — it used to test `contextId`
   * type-blind, which is how a global conversation came to "belong" to every
   * page), so this is defence in depth — and defence in depth is not something
   * a cutover gets to quietly drop. It was also the thing that CONTAINED that
   * defect: a global conversation matched no rows here, so the injected turn
   * never read anyone's history back.
   */
  async getPageConversationMessages(
    pageId: string,
    conversationId: string,
    includeStreaming = false,
  ): Promise<UnifiedPageMessageRow[]> {
    return db
      .select({ ...unifiedColumns, pageId: derivedPageId() })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(
        unifiedPageScope(pageId),
        eq(messages.conversationId, conversationId),
        eq(messages.isActive, true),
        ...(includeStreaming ? [] : [ne(messages.status, 'streaming')]),
      ))
      .orderBy(asc(messages.createdAt), asc(messages.id));
  },

  /**
   * ONE USER'S most recent durable messages on a page, oldest-first — the
   * consult route's no-conversationId fallback context. Ordered DESC then
   * reversed, because ordering ASC under a LIMIT would return that user's
   * FIRST n messages ever.
   *
   * The owner predicate is not optional and there is deliberately no unscoped
   * variant. `unifiedPageScope` answers "which page", never "whose", so the
   * page-scoped-only version of this read handed the caller the 10 most recent
   * messages on a SHARED agent page across every user — a cross-user
   * transcript leak straight into the model context, on a route whose only
   * gate was `canPrincipalViewPage` ("may you use this agent"). Scoped to the
   * caller's own conversations rather than also including `isShared` ones:
   * this is background context for a one-shot consult, so the narrow answer is
   * the right default, and a caller who wants a specific shared thread can
   * name it (that path runs `authorizePageConversation`).
   */
  async getRecentPageMessagesForUser(
    pageId: string,
    userId: string,
    limit: number,
  ): Promise<UnifiedPageMessageRow[]> {
    const rows = await db
      .select({ ...unifiedColumns, pageId: derivedPageId() })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(
        unifiedPageScope(pageId),
        eq(conversations.userId, userId),
        eq(messages.isActive, true),
        ne(messages.status, 'streaming'),
      ))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit);
    return rows.reverse();
  },

  /**
   * One message by id, with its page derived — the edit/delete routes' read.
   * The unified replacement for `chatMessageRepository.getMessageById`.
   *
   * Returns soft-deleted rows too (the legacy reader did; the routes make
   * their own `isActive` decision). A GLOBAL-assistant row resolves with
   * `pageId: null`, which is the callers' cue to 404 — before the cutover
   * those ids simply did not exist in the page-chat table, and a page route
   * must not become a second door onto a global message.
   */
  async getMessageById(messageId: string): Promise<UnifiedPageMessageRow | null> {
    const [row] = await db
      .select({ ...unifiedColumns, pageId: derivedPageId() })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(messages.id, messageId))
      .limit(1);
    return row ?? null;
  },

  /**
   * One ACTIVE message scoped to its conversation — the global-assistant
   * edit/delete routes' read (formerly
   * `globalConversationRepository.getMessageById`).
   */
  async getMessageInConversation(
    conversationId: string,
    messageId: string,
  ): Promise<UnifiedMessageRow | null> {
    const [row] = await db
      .select(unifiedColumns)
      .from(messages)
      .where(and(
        eq(messages.id, messageId),
        eq(messages.conversationId, conversationId),
        eq(messages.isActive, true),
      ))
      .limit(1);
    return row ?? null;
  },

  /**
   * Overwrite (not merge) a message's `toolResults` — the OpenAI-compatible
   * route's client-tool-result back-fill, and the one durable message-content
   * write that never had a full save path. No-op when there is nothing to
   * persist. Idempotent: the same results are re-supplied on every subsequent
   * request.
   *
   * Scoped by `conversationId` as well as id, which is the caller's authority
   * boundary: the v1 route has been authorized for a conversation, not for an
   * arbitrary message id.
   */
  async updateMessageToolResults(
    messageId: string,
    conversationId: string,
    toolResults: ToolResult[],
  ): Promise<void> {
    if (toolResults.length === 0) return;
    const serialized = JSON.stringify(toolResults);
    await mutateUnifiedMessageById(db, messageId, { toolResults: serialized }, { conversationId });
  },

  /**
   * The STANDALONE recompute for `conversations.lastMessageAt` (#2153), for the
   * mutations that cannot fold it into their own write: the retention purge
   * (which sweeps many conversations, so a bump-and-emit per row would be a
   * broadcast storm from a cron) and the interrupted-stream materializer.
   *
   * The soft-delete paths do NOT call this — they recompute inside their write
   * transaction via `tombstoneAndRebump`, so the new sort key rides the same
   * statement as the rev bump and the post-commit event carries it. This used
   * to be their route too, called after commit with the failure swallowed, and
   * two of the three never called it at all.
   *
   * Runs in its own transaction and locks the conversation row FIRST, before
   * reading the surviving messages. Without this, a concurrent writer (a
   * normal message save, or another recompute from a concurrent delete)
   * targeting the same conversation can commit between this function's own
   * SELECT and UPDATE, and this UPDATE then silently overwrites that writer's
   * fresher timestamp with a stale snapshot. The lock forces concurrent
   * recomputes (and any other writer to this row — a plain UPDATE takes the
   * same implicit row lock even without FOR UPDATE) to serialize.
   * Mirrors `recomputeConversationLastMessage` in dm-message-repository.ts.
   *
   * Since the merge it covers PAGE conversations too — they read from the same
   * table now, so the field they sort on has to be recomputed from the same
   * rows.
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
          eq(messages.isActive, true),
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
   * Hard-delete soft-deleted UNIFIED messages older than the cutoff, and
   * recompute `lastMessageAt` for every conversation that lost a row. Returns
   * the number of rows removed.
   *
   * Absorbs `globalConversationRepository.purgeInactiveMessages`, and now
   * covers page rows as well — they live in this table.
   */
  async purgeInactiveMessages(olderThan: Date): Promise<number> {
    const result = await db
      .delete(messages)
      .where(and(eq(messages.isActive, false), lt(messages.createdAt, olderThan)))
      .returning({ id: messages.id, conversationId: messages.conversationId });

    const affectedConversationIds = new Set(result.map((m) => m.conversationId));
    for (const conversationId of affectedConversationIds) {
      // Isolated per conversation (#2153 review follow-up): the primary delete
      // has already committed, and a single throw would abort every remaining
      // conversation in iteration order and lose an already-correct count.
      try {
        await messageRepository.recomputeLastMessageAt(conversationId);
      } catch (error) {
        loggers.ai.warn('purgeInactiveMessages: lastMessageAt recompute failed', {
          conversationId,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    return result.length;
  },
};

/**
 * Process message content, preserving structured content format if present.
 * Pure function, moved verbatim from the deleted `chat-message-repository.ts`.
 */
export function processMessageContentUpdate(
  existingContent: string,
  newContent: string,
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
