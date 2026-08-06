/**
 * The in-transaction `conversations.rev` bump every durable write shares
 * (Agent-Session Single Source of Truth epic, Phase 2; spec §3 clause 2:
 * "every owner emits on write ... the event carries the post-write rev").
 *
 * One statement: `SET rev = rev + 1 [, lastMessageAt = ...] RETURNING *` —
 * so the counter, the timestamp, and the row facts the emitter needs
 * (owner, isShared, scope, workspace binding) come back atomically with the
 * write that bumped them. Runs on the CALLER's transaction so a rollback
 * takes the bump with it and no event is ever emitted for an uncommitted
 * write.
 */

import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import { loggers } from '@pagespace/lib/logging/logger-config';
import type {
  ConversationChangedFields,
  ConversationEmitContext,
  ConversationEventScope,
  ConversationEventTriggeredBy,
} from '@/lib/websocket/conversation-events';
import { conversationEvents, SERVER_TRIGGERED_BROWSER_SESSION } from '@/lib/websocket/conversation-events';

/** Any drizzle executor — the module `db` or a transaction handle. */
export type DbExecutor = typeof db;

/** The row facts the emitters need, returned by the bump's RETURNING. */
export interface BumpedConversationRow {
  id: string;
  rev: number;
  userId: string;
  isShared: boolean;
  sessionId: string | null;
  type: string;
  contextId: string | null;
  title: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  closedInSessionAt: Date | null;
  isActive: boolean;
}

const BUMP_RETURNING = {
  id: conversations.id,
  rev: conversations.rev,
  userId: conversations.userId,
  isShared: conversations.isShared,
  sessionId: conversations.sessionId,
  type: conversations.type,
  contextId: conversations.contextId,
  title: conversations.title,
  lastMessageAt: conversations.lastMessageAt,
  createdAt: conversations.createdAt,
  closedInSessionAt: conversations.closedInSessionAt,
  isActive: conversations.isActive,
};

/**
 * Bump the conversation's rev (and optionally its lastMessageAt) in the
 * caller's transaction. Returns null when no `conversations` row exists —
 * legacy page conversations; the caller still emits its content event with
 * rev 0 but skips directory events (no owner fact to target them with).
 *
 * `extraSet` lets a lifecycle write (title, isShared, sessionId claim,
 * closedInSessionAt) fold its own column change into the SAME statement as
 * the bump.
 */
export async function bumpConversationRev(
  executor: DbExecutor,
  conversationId: string,
  opts: {
    touchLastMessageAt?: Date;
    extraSet?: Partial<typeof conversations.$inferInsert>;
  } = {},
): Promise<BumpedConversationRow | null> {
  const [row] = await executor
    .update(conversations)
    .set({
      rev: sql`${conversations.rev} + 1`,
      updatedAt: new Date(),
      ...(opts.touchLastMessageAt ? { lastMessageAt: opts.touchLastMessageAt } : {}),
      ...(opts.extraSet ?? {}),
    })
    .where(eq(conversations.id, conversationId))
    .returning(BUMP_RETURNING);
  return row ?? null;
}

/** Derive the event scope from a conversation row. */
export function scopeFromRow(row: Pick<BumpedConversationRow, 'type' | 'contextId' | 'userId'>): ConversationEventScope {
  return row.type === 'page' && row.contextId
    ? { kind: 'page', pageId: row.contextId }
    : { kind: 'global', ownerId: row.userId };
}

/**
 * Fire-and-forget directory emission for a lifecycle write (create / rename /
 * share / claim / close / reopen / delete). Never throws — a committed
 * lifecycle write must not un-succeed because a broadcast failed. Shared by
 * conversation-repository.ts and global-conversation-repository.ts so the two
 * cannot drift on shape.
 */
export function emitConversationLifecycle(
  kind: 'created' | 'updated' | 'closed' | 'reopened' | 'deleted',
  row: BumpedConversationRow,
  triggeredBy?: ConversationEventTriggeredBy,
  changes?: ConversationChangedFields,
): void {
  const ctx = emitContextFromRow(row, triggeredBy);
  void (async () => {
    if (kind === 'created') {
      await conversationEvents.created(ctx, {
        id: row.id,
        title: row.title,
        type: row.type,
        contextId: row.contextId,
        workspaceId: row.sessionId,
        isShared: row.isShared,
        createdAt: row.createdAt.toISOString(),
        lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
      });
    } else if (kind === 'updated') {
      await conversationEvents.updated(ctx, changes ?? {});
    } else {
      await conversationEvents[kind](ctx);
    }
  })().catch((error) => {
    loggers.api.warn('conversation lifecycle event emission failed', {
      conversationId: row.id,
      kind,
      error: error instanceof Error ? error.message : 'unknown',
    });
  });
}

/** Build the emitter context from a bumped row + the acting principal. */
export function emitContextFromRow(
  row: BumpedConversationRow,
  triggeredBy?: ConversationEventTriggeredBy,
): ConversationEmitContext {
  return {
    conversationId: row.id,
    rev: row.rev,
    scope: scopeFromRow(row),
    workspaceId: row.sessionId,
    ownerId: row.userId,
    isShared: row.isShared,
    triggeredBy: triggeredBy ?? {
      userId: row.userId,
      browserSessionId: SERVER_TRIGGERED_BROWSER_SESSION,
    },
  };
}
