import { db as defaultDb } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';

export class ConversationOwnershipError extends Error {
  constructor() {
    super('Conversation belongs to a different user');
    this.name = 'ConversationOwnershipError';
  }
}

/**
 * The id resolves to a row, but it has been history-deleted
 * (`isActive: false`) — reachable via the concurrent-insert fallback below:
 * the initial SELECT filters `isActive: true` (so a history-deleted row
 * reads as "does not exist"), the INSERT then collides on the id's primary
 * key and is swallowed by `onConflictDoNothing`, and the fallback SELECT
 * that resolves "who won the race" has no `isActive` filter at all — so it
 * silently returns the STALE INACTIVE row, mislabeled `isNew: true`, and
 * the caller would persist a new message beneath a conversation excluded
 * from every session listing (same class of bug as the page-agent send
 * route's missing isActive check — review finding, chatgpt-codex-connector
 * on PR #2296).
 */
export class ConversationHistoryDeletedError extends Error {
  constructor() {
    super('Conversation has been deleted from history');
    this.name = 'ConversationHistoryDeletedError';
  }
}

// CUID2 format: starts with lowercase letter, followed by 1–31 lowercase alphanumeric chars.
const CUID2_RE = /^[a-z][a-z0-9]{1,31}$/;

type ConversationRow = typeof conversations.$inferSelect;
type Db = typeof defaultDb;

export interface ResolveOrCreateResult {
  conversation: ConversationRow;
  /** True when the DB row was just inserted (lazy first-message creation). */
  isNew: boolean;
}

/**
 * Pure-ish function: resolve an existing global conversation or create it on first message.
 * Throws ConversationOwnershipError if the conversation exists but belongs to a different user.
 *
 * This enables lazy conversation creation: the client generates a CUID2 locally and only
 * the first POST to the messages route triggers the DB insert.
 *
 * Concurrent first-writes are safe: insert uses ON CONFLICT DO NOTHING, and falls back
 * to a select when no row is returned (i.e. a racing insert won the race).
 */
export async function resolveOrCreateConversation(
  userId: string,
  conversationId: string,
  db: Db = defaultDb,
  opts?: {
    /** Display label for the new row (spawned workers are labeled at birth). Ignored for an existing row. */
    title?: string;
  },
): Promise<ResolveOrCreateResult> {
  if (!CUID2_RE.test(conversationId)) {
    throw new ConversationOwnershipError();
  }

  // `FOR UPDATE` — a no-op standalone (each statement is its own implicit
  // transaction), but when the caller wraps this call in an explicit
  // `db.transaction()` alongside the first message's persist, it locks the
  // row for the transaction's duration: a concurrent History-delete's
  // `UPDATE conversations SET isActive = false ...` on the SAME row blocks
  // until this transaction commits (or, if the delete's UPDATE landed
  // first, this SELECT blocks until IT commits and then correctly re-reads
  // isActive: false). Without this, the isActive check and the message
  // insert are two independent statements with an unguarded gap between
  // them — exactly the race this exists to close (review finding —
  // chatgpt-codex-connector and coderabbitai on PR #2299).
  const [existing] = await db
    .select()
    .from(conversations)
    .where(and(
      eq(conversations.id, conversationId),
      eq(conversations.isActive, true),
    ))
    .for('update')
    .limit(1);

  if (existing) {
    if (existing.userId !== userId) throw new ConversationOwnershipError();
    if (existing.type !== 'global') throw new ConversationOwnershipError();
    return { conversation: existing, isNew: false };
  }

  // Idempotent insert: ON CONFLICT DO NOTHING handles concurrent first-writes.
  // Always session-agnostic — this never writes `sessionId` (there is no
  // param for it). A conversation that needs a session gets one afterward,
  // via `claimConversationInSession` (see `claim-conversation-in-session.ts`).
  const [created] = await db
    .insert(conversations)
    .values({
      id: conversationId,
      userId,
      type: 'global',
      isActive: true,
      sessionId: null,
      title: opts?.title ?? null,
    })
    .onConflictDoNothing()
    .returning();

  if (created) return { conversation: created, isNew: true };

  // A concurrent insert won the race — select the winner. Locked for the same
  // reason as the initial SELECT above.
  const [winner] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for('update')
    .limit(1);

  if (!winner) throw new Error(`Failed to resolve conversation ${conversationId}`);
  if (!winner.isActive) throw new ConversationHistoryDeletedError();
  if (winner.userId !== userId) throw new ConversationOwnershipError();
  return { conversation: winner, isNew: true };
}
