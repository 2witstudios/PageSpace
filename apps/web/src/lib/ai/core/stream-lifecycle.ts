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
}

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

  const finish = (aborted: boolean): void => {
    if (finished) return;
    finished = true;

    try {
      streamMulticastRegistry.finish(messageId, aborted);
    } catch (error) {
      loggers.ai.warn('stream-lifecycle: registry.finish threw', {
        messageId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }

    void (async () => {
      try {
        await db
          .update(aiStreamSessions)
          .set({
            status: aborted ? 'aborted' : 'complete',
            completedAt: new Date(),
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
      aborted,
    }).catch(() => {});
  };

  const pushPart = (part: UIMessagePart): void => {
    try {
      streamMulticastRegistry.push(messageId, part);
    } catch (error) {
      // one bad chunk must not interrupt the stream — log so the swallow stays observable
      loggers.ai.warn('stream-lifecycle: registry.push threw', {
        messageId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  };

  return { finish, pushPart };
};
