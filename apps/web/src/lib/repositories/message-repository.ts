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
 * ── DUAL-WRITE (Phase 4 PR 10, D6) ────────────────────────────────────────
 * Every PAGE write below now lands in both `chat_messages` (legacy leg) and
 * `messages` (unified leg) inside the SAME transaction, via the shared
 * unified-leg writer (`unified-message-leg.ts`). Being the choke point is
 * what makes that a per-method two-liner instead of ~10 route edits — no
 * route changed for the dual-write. GLOBAL writes were always `messages`
 * writes; they gained nothing but explicit `pageId: null` / `sourceAgentId:
 * null` so a global row reads as "not a page row" after the cutover.
 * The rev bump and the event emission are untouched by all of this.
 *
 * Kill switch: `UNIFIED_MESSAGES_DUAL_WRITE=off` disables the unified leg
 * alone (apps/web/src/lib/config/unified-messages-env.ts). Nothing here reads
 * `process.env` directly.
 */

import type { UIMessage } from 'ai';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { chatMessages } from '@pagespace/db/schema/core';
import { messages } from '@pagespace/db/schema/conversations';
import { conversations } from '@pagespace/db/schema/conversations';
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
import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';
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
} from '@/lib/repositories/unified-message-leg';

// ---------------------------------------------------------------------------
// Private raw savers — moved verbatim from message-utils.ts (where they were
// exported and ~10 call sites saved directly). Unexported ON PURPOSE: the
// only path to a message write is a repository method that bumps rev and
// emits.
// ---------------------------------------------------------------------------

async function saveChatMessageRow({
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

  // Serialized (and timestamped) ONCE, then handed to both legs: the two
  // tables must hold byte-identical values, and an identical `createdAt` in
  // particular — the drift reconciler compares `MAX("createdAt")` per
  // conversation, so two `new Date()` calls a millisecond apart would show up
  // as permanent, meaningless divergence.
  const toolCallsJson = serializeJsonColumn(toolCalls);
  const toolResultsJson = serializeJsonColumn(toolResults);
  const createdAt = new Date();

  // Scoped upsert: the `where` gates ON CONFLICT DO UPDATE to a row already
  // in the CALLER's own conversation AND under the same role. A
  // client-supplied messageId can collide with a row in a DIFFERENT
  // conversation (single global id space) — the gate makes such a collision
  // skip the conflict action entirely (no overwrite, no re-parent), and the
  // role half closes same-conversation role spoofing (a 'user' save whose id
  // equals an existing 'assistant' row's). `.returning()` turns the silent
  // no-op into a caller-visible failure. Full history: message-utils.ts
  // (this upsert's original home) and PR reviews cited there.
  const result = await dbClient
    .insert(chatMessages)
    .values({
      id: messageId,
      pageId,
      conversationId,
      userId,
      role,
      content: structuredContent,
      toolCalls: toolCallsJson,
      toolResults: toolResultsJson,
      createdAt,
      isActive: true,
      sourceAgentId: sourceAgentId ?? null,
      status,
    })
    .onConflictDoUpdate({
      target: chatMessages.id,
      set: {
        content: structuredContent,
        toolCalls: toolCallsJson,
        toolResults: toolResultsJson,
        sourceAgentId: sourceAgentId ?? null,
        // Terminal write: flips a 'streaming' placeholder to
        // 'complete'/'interrupted', never back to 'streaming'.
        status,
      },
      where: and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.role, role)),
    })
    .returning({ id: chatMessages.id });

  // UNIFIED LEG (Phase 4 PR 10) — same transaction, same statement shape.
  // Gated on the legacy leg having actually written: a zero-row result means
  // the scoped-upsert gate REJECTED this write (colliding id from another
  // conversation, or a role spoof) and the throw below aborts the whole
  // transaction. Mirroring a rejected write onto the unified leg would be
  // creating exactly the cross-conversation row the gate exists to refuse.
  if (result.length > 0) {
    await upsertUnifiedPageMessage(dbClient, {
      messageId,
      pageId,
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
  }

  if (result.length === 0) {
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

  // Scoped upsert — see saveChatMessageRow's comment; same collision and
  // role-spoofing gates, mirrored for the global assistant table.
  //
  // NOT dual-written: `messages` IS the global leg. It is the same table the
  // page leg is being merged into, which is why the two new columns from
  // migration 0248 are spelled out explicitly below rather than left to the
  // column defaults — a global row must read as "not a page row" to the
  // post-cutover readers, and `pageId: null` is what says so.
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
      // A global-assistant thread has no page: `conversations.type='global'`
      // and (per 0249's CHECK) a NULL `contextId`. Never a page id.
      pageId: null,
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
        workspaceId: args.row.sessionId,
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
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(eq(chatMessages.id, args.messageId))
        .limit(1);
      await saveChatMessageRow({ ...args, dbClient: tx });
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
        workspaceId: outcome.row?.sessionId ?? null,
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
        workspaceId: outcome.row?.sessionId ?? null,
        ownerId: outcome.row?.userId ?? args.userId,
        isShared: outcome.row?.isShared ?? false,
        triggeredBy,
      },
    });
    return { saved: true, rev: outcome.row?.rev ?? 0 };
  },

  /**
   * The 'streaming' placeholder row a page-agent generation plants at stream
   * start. Bakes in the route's atomic isActive re-check (`FOR UPDATE`):
   * an EXPLICITLY inactive conversation skips the insert; an absent row is
   * tolerated (the eager createConversation call is best-effort — see the
   * route's review history on PR #2299).
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
      await tx.insert(chatMessages).values({
        id: args.messageId,
        pageId: args.pageId,
        conversationId: args.conversationId,
        role: 'assistant',
        content: '',
        toolCalls: null,
        toolResults: null,
        isActive: true,
        userId: null,
        sourceAgentId: null,
        status: 'streaming',
      });
      // UNIFIED LEG. `row` is the SELECT ... FOR UPDATE result a few lines up,
      // so it already answers "does a conversations row exist" for the exact
      // version this transaction locked — no second probe, no stale answer.
      // An absent row is tolerated on the legacy leg (documented above) and
      // therefore skipped, loudly, on the unified one.
      await insertUnifiedPageMessage(
        tx,
        {
          messageId: args.messageId,
          pageId: args.pageId,
          conversationId: args.conversationId,
          userId: null,
          role: 'assistant',
          content: '',
          toolCallsJson: null,
          toolResultsJson: null,
          sourceAgentId: null,
          status: 'streaming',
        },
        row !== undefined,
      );
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
        // Global leg — see saveGlobalMessageRow for why these are explicit.
        pageId: null,
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
      const written = await tx
        .insert(chatMessages)
        .values({
          id: args.messageId,
          pageId: args.pageId,
          conversationId: args.conversationId,
          role: 'assistant',
          content: args.structuredContent,
          toolCalls: args.toolCallsJson,
          toolResults: args.toolResultsJson,
          createdAt: args.createdAt,
          isActive: true,
          userId: null,
          sourceAgentId: null,
          status: 'interrupted',
        })
        .onConflictDoUpdate({
          target: chatMessages.id,
          set: {
            content: args.structuredContent,
            toolCalls: args.toolCallsJson,
            toolResults: args.toolResultsJson,
            conversationId: args.conversationId,
            status: 'interrupted',
          },
          setWhere: eq(chatMessages.status, 'streaming'),
        })
        .returning({ id: chatMessages.id });
      if (written.length === 0) return null;
      // UNIFIED LEG — mirrors the CAS (`setWhere status = 'streaming'`), so a
      // row already terminal on the unified leg is left alone there too.
      await materializeUnifiedPageMessage(tx, {
        messageId: args.messageId,
        pageId: args.pageId,
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
          // Global leg — see saveGlobalMessageRow for why these are explicit.
          pageId: null,
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
    const row = await db.transaction(async (tx) => {
      const editedAt = new Date();
      await tx
        .update(chatMessages)
        .set({ content: args.updatedContent, editedAt })
        .where(eq(chatMessages.id, args.messageId));
      // UNIFIED LEG. Zero matched rows is normal pre-backfill (the message
      // predates the copy) and stays silent — the backfill will bring the
      // already-edited legacy row across verbatim.
      await mutateUnifiedMessageById(tx, args.messageId, { content: args.updatedContent, editedAt });
      return bumpConversationRev(tx, args.conversationId);
    });

    void (async () => {
      const updated = await chatMessageRepository.getMessageById(args.messageId);
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
    const row = await db.transaction(async (tx) => {
      await tx
        .update(chatMessages)
        .set({ isActive: false })
        .where(eq(chatMessages.id, args.messageId));
      // UNIFIED LEG — a delete that only lands on one leg would be resurrected
      // by the post-cutover reader, so it is mirrored even though zero matched
      // rows is normal pre-backfill.
      await mutateUnifiedMessageById(tx, args.messageId, { isActive: false });
      return bumpConversationRev(tx, args.conversationId);
    });

    void (async () => {
      await broadcastAiMessageDeleted({
        messageId: args.messageId,
        pageId: args.pageId,
        conversationId: args.conversationId,
        triggeredBy: args.legacyTriggeredBy,
      });
      const ctx = contextForMutation(row, args.conversationId, { kind: 'page', pageId: args.pageId }, args.legacyTriggeredBy);
      await conversationEvents.messageDeleted(ctx, args.messageId, { skipDirectory: row === null });
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
    const row = await db.transaction(async (tx) => {
      await tx
        .update(messages)
        .set({ content: args.updatedContent, editedAt: new Date() })
        .where(eq(messages.id, args.messageId));
      return bumpConversationRev(tx, args.conversationId);
    });

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

  /** Soft-delete a global-assistant message (with the repo's lastMessageAt recompute preserved). */
  async softDeleteGlobalMessage(args: {
    messageId: string;
    conversationId: string;
    ownerUserId: string;
    legacyTriggeredBy: TriggeredBy;
  }): Promise<void> {
    const row = await db.transaction(async (tx) => {
      await tx
        .update(messages)
        .set({ isActive: false })
        .where(eq(messages.id, args.messageId));
      return bumpConversationRev(tx, args.conversationId);
    });

    // Preserve the pre-existing recompute-on-delete behavior (#2153) — the
    // newest surviving message decides lastMessageAt, not "now".
    try {
      await globalConversationRepository.recomputeLastMessageAt(args.conversationId);
    } catch (error) {
      loggers.ai.warn('messageRepository: lastMessageAt recompute failed after delete', {
        conversationId: args.conversationId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }

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
      await conversationEvents.messageDeleted(ctx, args.messageId, { skipDirectory: row === null });
    })().catch((error) => {
      loggers.api.error('messageRepository: global delete broadcast failed', error as Error, {
        messageId: args.messageId,
      });
    });
  },

  /**
   * Record an executed undo: bump rev, emit the legacy `chat:undo_applied`
   * (moved in from the undo route) plus the authoritative
   * `conversation:undo_applied`. The undo's own message deletions happen in
   * `executeAiUndo` (services layer); this is the one post-commit record +
   * emission point for them.
   */
  async recordUndoApplied(args: {
    conversationId: string;
    /** The legacy broadcast channel: the pageId for page chat, `user:<id>:global` otherwise. */
    legacyChannelId: string;
    scope: ConversationEmitContext['scope'];
    mode: 'messages_only' | 'messages_and_changes';
    affectedMessageIds: string[];
    legacyTriggeredBy: TriggeredBy;
  }): Promise<void> {
    const row = await bumpConversationRev(db, args.conversationId);

    await broadcastAiUndoApplied({
      conversationId: args.conversationId,
      pageId: args.legacyChannelId,
      mode: args.mode,
      affectedMessageIds: args.affectedMessageIds,
      triggeredBy: args.legacyTriggeredBy,
    });
    const ctx = contextForMutation(row, args.conversationId, args.scope, args.legacyTriggeredBy);
    await conversationEvents.undoApplied(
      ctx,
      { mode: args.mode, affectedMessageIds: args.affectedMessageIds },
      { skipDirectory: row === null },
    );
  },

};
