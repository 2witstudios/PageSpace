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
 * The conversation exists but its session binding disagrees with the one the
 * caller asked for. A thread is BORN into its session (set at creation,
 * permanent — contract invariant 1); satisfying this request would be a
 * rebind, so it is refused rather than performed. Distinct from
 * {@link ConversationOwnershipError} because the caller may well OWN the
 * thread — the refusal is about the binding, not the owner.
 */
export class ConversationBindingConflictError extends Error {
  constructor() {
    super('Conversation is already bound to a different session');
    this.name = 'ConversationBindingConflictError';
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
    /**
     * Bind the conversation to this session AT CREATION (the only moment a
     * binding may be written — invariant 1). For an already-existing row the
     * binding must MATCH (an idempotent retry), or the resolve is refused
     * with {@link ConversationBindingConflictError} — never rebound.
     */
    sessionId?: string;
    /** Display label for the new row (spawned workers are labeled at birth). Ignored for an existing row. */
    title?: string;
  },
): Promise<ResolveOrCreateResult> {
  if (!CUID2_RE.test(conversationId)) {
    throw new ConversationOwnershipError();
  }

  const [existing] = await db
    .select()
    .from(conversations)
    .where(and(
      eq(conversations.id, conversationId),
      eq(conversations.isActive, true),
    ))
    .limit(1);

  if (existing) {
    if (existing.userId !== userId) throw new ConversationOwnershipError();
    if (existing.type !== 'global') throw new ConversationOwnershipError();
    if (opts?.sessionId !== undefined && existing.sessionId !== opts.sessionId) {
      throw new ConversationBindingConflictError();
    }
    return { conversation: existing, isNew: false };
  }

  // Idempotent insert: ON CONFLICT DO NOTHING handles concurrent first-writes.
  const [created] = await db
    .insert(conversations)
    .values({
      id: conversationId,
      userId,
      type: 'global',
      isActive: true,
      sessionId: opts?.sessionId ?? null,
      title: opts?.title ?? null,
    })
    .onConflictDoNothing()
    .returning();

  if (created) return { conversation: created, isNew: true };

  // A concurrent insert won the race — select the winner.
  const [winner] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (!winner) throw new Error(`Failed to resolve conversation ${conversationId}`);
  if (!winner.isActive) throw new ConversationHistoryDeletedError();
  if (winner.userId !== userId) throw new ConversationOwnershipError();
  if (opts?.sessionId !== undefined && winner.sessionId !== opts.sessionId) {
    // The racing insert won without our binding — same refusal as any other
    // existing-row mismatch.
    throw new ConversationBindingConflictError();
  }
  return { conversation: winner, isNew: true };
}
