import { db as defaultDb } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';

export class ConversationOwnershipError extends Error {
  constructor() {
    super('Conversation belongs to a different user');
    this.name = 'ConversationOwnershipError';
  }
}

type ConversationRow = typeof conversations.$inferSelect;
type Db = typeof defaultDb;

/**
 * Pure-ish function: resolve an existing conversation or create it on first message.
 * Throws ConversationOwnershipError if the conversation exists but belongs to a different user.
 *
 * This enables lazy conversation creation: the client generates a CUID2 locally and only
 * the first POST to the messages route triggers the DB insert.
 */
export async function resolveOrCreateConversation(
  userId: string,
  conversationId: string,
  db: Db = defaultDb,
): Promise<ConversationRow> {
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
    return existing;
  }

  const [created] = await db
    .insert(conversations)
    .values({
      id: conversationId,
      userId,
      type: 'global',
      isActive: true,
    })
    .returning();

  return created;
}
