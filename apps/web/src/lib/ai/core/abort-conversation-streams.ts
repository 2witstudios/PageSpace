import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { abortStreamByMessageId } from './stream-abort-registry';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * Abort the caller's in-flight streams on a conversation, named by CONVERSATION rather than by
 * streamId or messageId.
 *
 * This exists to close a window in which Stop did nothing at all.
 *
 * Both `streamId` and `messageId` are minted SERVER-side, and the client does not learn either
 * until the response headers arrive (`X-Stream-Id`). But a real agent send spends 0.5-3 seconds
 * before that — auth, rate limit, DB reads, context assembly, connecting to the provider. Press
 * Stop in that window (exactly when a user who has spotted a typo does) and the client had no
 * name for the stream: the abort was a guaranteed no-op, the local fetch was cancelled, and the
 * button flipped back to Send.
 *
 * Streams are deliberately server-owned and survive a client disconnect — that is the entire
 * architecture. So cancelling the fetch stops NOTHING: the generation kept running, kept calling
 * write tools, and kept billing, while the UI told the user it had stopped.
 *
 * The conversationId is the one name the client holds from t=0. So Stop can now always say
 * something true.
 *
 * AUTHORIZATION — deliberately stricter than the takeover's.
 *
 * `takeOverConversationStreams` aborts as the STREAM's owner (`row.userId`), because a second
 * send on a SHARED conversation must be able to take over a co-member's generation. This is not
 * that. This is an explicit user Stop, so it may only ever stop the caller's OWN streams: the
 * `userId` filter is in the query, and the registry re-checks ownership on every abort. A user
 * cannot stop someone else's generation by naming their conversation.
 */
export const abortConversationStreams = async ({
  conversationId,
  userId,
}: {
  conversationId: string;
  userId: string;
}): Promise<{ aborted: string[]; reason: string }> => {
  let rows: { messageId: string }[];
  try {
    rows = await db
      .select({ messageId: aiStreamSessions.messageId })
      .from(aiStreamSessions)
      .where(and(
        eq(aiStreamSessions.conversationId, conversationId),
        // The caller's own streams only. See the authz note above.
        eq(aiStreamSessions.userId, userId),
        eq(aiStreamSessions.status, 'streaming'),
      ));
  } catch (error) {
    loggers.ai.warn('abort-by-conversation: lookup failed', {
      conversationId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return { aborted: [], reason: 'Lookup failed' };
  }

  const aborted: string[] = [];
  for (const row of rows) {
    // Registry re-checks ownership; passing the caller's id (not the row's) is the point.
    const result = abortStreamByMessageId({ messageId: row.messageId, userId });
    if (result.aborted) aborted.push(row.messageId);
  }

  if (aborted.length === 0) {
    // Not an error. The stream may live on another web instance (the abort registry is
    // in-process), or it may have finished between the SELECT and here. Reported honestly
    // rather than as a success.
    return {
      aborted: [],
      reason: rows.length > 0
        ? 'In-flight stream(s) found but none could be aborted from this instance'
        : 'No in-flight stream on this conversation',
    };
  }

  return { aborted, reason: '' };
};
