import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';

/**
 * Who may SUBSCRIBE to a server-owned stream.
 *
 * Page access is not the right question. A page channel carries every conversation on
 * that page, and conversations are PRIVATE by default — so authorizing a stream
 * subscription on "can this user view the page" hands one member's private conversation,
 * token by token, to every other member who opens it. That was true of both
 * `/api/ai/chat/active-streams` (which also returns the buffered `parts` snapshot) and
 * `/api/ai/chat/stream-join/[messageId]`.
 *
 * The right question is the conversation's. You may subscribe to a stream when:
 *   - you started it (the stream row carries its owner), or
 *   - its conversation is explicitly shared.
 *
 * Fails closed: a conversation with no row is not shared, so a non-owner gets nothing.
 * Page-level authorization still runs first at each call site — this narrows it, it does
 * not replace it.
 */
export const canSubscribeToStream = async ({
  userId,
  streamOwnerId,
  conversationId,
}: {
  userId: string;
  streamOwnerId: string;
  conversationId: string;
}): Promise<boolean> => {
  if (streamOwnerId === userId) return true;

  const [conversation] = await db
    .select({ isShared: conversations.isShared })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  return conversation?.isShared === true;
};

/**
 * Batched form of `canSubscribeToStream` for the active-streams listing: returns the
 * subset of `rows` this user may subscribe to. One query regardless of row count.
 */
export const filterSubscribableStreams = async <
  T extends { userId: string; conversationId: string },
>({
  userId,
  rows,
}: {
  userId: string;
  rows: T[];
}): Promise<T[]> => {
  const foreign = rows.filter((r) => r.userId !== userId);
  if (foreign.length === 0) return rows;

  const sharedIds = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(
      inArray(conversations.id, [...new Set(foreign.map((r) => r.conversationId))]),
      eq(conversations.isShared, true),
    ));

  const shared = new Set(sharedIds.map((c) => c.id));
  return rows.filter((r) => r.userId === userId || shared.has(r.conversationId));
};
