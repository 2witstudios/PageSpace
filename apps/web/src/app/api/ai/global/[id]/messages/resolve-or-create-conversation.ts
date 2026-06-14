import { db as defaultDb } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';

export class ConversationOwnershipError extends Error {
  constructor() {
    super('Conversation belongs to a different user');
    this.name = 'ConversationOwnershipError';
  }
}

// CUID2 format: starts with lowercase letter, followed by 1–31 lowercase alphanumeric chars.
const CUID2_RE = /^[a-z][a-z0-9]{1,31}$/;

type ConversationRow = typeof conversations.$inferSelect;
type Db = typeof defaultDb;

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
): Promise<ConversationRow> {
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
    return existing;
  }

  // Idempotent insert: ON CONFLICT DO NOTHING handles concurrent first-writes.
  const [created] = await db
    .insert(conversations)
    .values({
      id: conversationId,
      userId,
      type: 'global',
      isActive: true,
    })
    .onConflictDoNothing()
    .returning();

  if (created) return created;

  // A concurrent insert won the race — select the winner.
  const [winner] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (!winner) throw new Error(`Failed to resolve conversation ${conversationId}`);
  if (winner.userId !== userId) throw new ConversationOwnershipError();
  return winner;
}
