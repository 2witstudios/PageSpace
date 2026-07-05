import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { broadcastAiStreamStart, broadcastAiStreamComplete } from '@/lib/websocket';
import {
  streamMulticastRegistry,
  type UIMessagePart,
} from '@/lib/ai/core/stream-multicast-registry';

export interface StreamLifecycleParams {
  messageId: string;
  channelId: string;
  conversationId: string;
  userId: string;
  displayName: string;
  browserSessionId: string;
}

export interface StreamLifecycleHandle {
  finish: (aborted: boolean) => void;
  pushPart: (part: UIMessagePart) => void;
  getBufferedParts: () => UIMessagePart[];
}

// Batch DB writes rather than persisting on every token — a checkpoint every
// N parts is enough to bound the unrecoverable window on process death while
// keeping write amplification low.
const PERSIST_EVERY_N_PARTS = 20;

export const createStreamLifecycle = async (
  params: StreamLifecycleParams,
): Promise<StreamLifecycleHandle> => {
  const { messageId, channelId, conversationId, userId, displayName, browserSessionId } = params;

  try {
    streamMulticastRegistry.register(messageId, {
      pageId: channelId,
      userId,
      displayName,
      conversationId,
      browserSessionId,
    });
  } catch (error) {
    loggers.ai.warn('stream-lifecycle: registry.register threw', {
      messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }

  try {
    await db
      .insert(aiStreamSessions)
      .values({
        messageId,
        channelId,
        conversationId,
        userId,
        displayName,
        browserSessionId,
        status: 'streaming',
      })
      .onConflictDoUpdate({
        target: aiStreamSessions.messageId,
        set: {
          channelId,
          conversationId,
          userId,
          displayName,
          browserSessionId,
          status: 'streaming',
          startedAt: new Date(),
          completedAt: null,
          // A re-registered messageId gets a fresh (empty) in-memory buffer
          // above — the DB snapshot must reset with it, or a bootstrap
          // between here and the first checkpoint would serve the prior
          // attempt's stale parts as if they were a prefix of this attempt.
          parts: [],
        },
      });
  } catch (error) {
    loggers.ai.warn('stream-lifecycle: aiStreamSessions INSERT failed', {
      messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }

  broadcastAiStreamStart({
    messageId,
    pageId: channelId,
    conversationId,
    triggeredBy: { userId, displayName, browserSessionId },
  }).catch(() => {});

  let finished = false;
  let partsSincePersist = 0;
  // Tracks the in-flight periodic write so finish() can await it before issuing
  // its own final write — otherwise a slow periodic write could resolve AFTER
  // finish()'s write and clobber the final parts with a stale snapshot.
  let persistInFlight: Promise<void> | null = null;

  const persistBufferedParts = (parts: UIMessagePart[]): Promise<void> => {
    const attempt = (async () => {
      try {
        await db
          .update(aiStreamSessions)
          .set({ parts })
          .where(eq(aiStreamSessions.messageId, messageId));
      } catch (error) {
        loggers.ai.warn('stream-lifecycle: aiStreamSessions parts persist failed', {
          messageId,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    })();
    persistInFlight = attempt;
    void attempt.finally(() => {
      if (persistInFlight === attempt) persistInFlight = null;
    });
    return attempt;
  };

  const finish = (aborted: boolean): void => {
    if (finished) return;
    finished = true;

    const priorPersist = persistInFlight;

    try {
      streamMulticastRegistry.finish(messageId, aborted);
    } catch (error) {
      loggers.ai.warn('stream-lifecycle: registry.finish threw', {
        messageId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }

    void (async () => {
      // Wait out any in-flight periodic persist so this final write always lands last.
      if (priorPersist) await priorPersist;
      try {
        await db
          .update(aiStreamSessions)
          .set({
            status: aborted ? 'aborted' : 'complete',
            completedAt: new Date(),
            // The only reader of this column (GET /api/ai/chat/active-streams)
            // filters status='streaming' — once the row leaves that status no
            // code ever reads its parts again, and the full message content is
            // already durably saved via the normal message-persistence path.
            // Clearing it here avoids keeping an unbounded, unpruned copy of
            // every AI reply's content sitting in this table indefinitely.
            parts: [],
          })
          .where(eq(aiStreamSessions.messageId, messageId));
      } catch (error) {
        loggers.ai.warn('stream-lifecycle: aiStreamSessions UPDATE failed', {
          messageId,
          aborted,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    })();

    broadcastAiStreamComplete({
      messageId,
      pageId: channelId,
      conversationId,
      aborted,
    }).catch(() => {});
  };

  const pushPart = (part: UIMessagePart): void => {
    // finish() already deleted the registry entry and issued the final
    // write; a part pushed after that point would still trip the checkpoint
    // below with an empty getBufferedParts() snapshot, racing the final
    // write with no ordering guarantee against it.
    if (finished) return;

    try {
      streamMulticastRegistry.push(messageId, part);
    } catch (error) {
      // one bad chunk must not interrupt the stream — log so the swallow stays observable
      loggers.ai.warn('stream-lifecycle: registry.push threw', {
        messageId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }

    partsSincePersist += 1;
    if (partsSincePersist >= PERSIST_EVERY_N_PARTS && !persistInFlight) {
      partsSincePersist = 0;
      persistBufferedParts(streamMulticastRegistry.getBufferedParts(messageId));
    }
  };

  const getBufferedParts = (): UIMessagePart[] =>
    streamMulticastRegistry.getBufferedParts(messageId);

  return { finish, pushPart, getBufferedParts };
};
