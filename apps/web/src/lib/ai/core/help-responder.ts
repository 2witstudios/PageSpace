/**
 * Answers a "solo" /help message (the chip with no other text) directly from
 * code — no streamText/model call, no credit hold. Reuses the exact building
 * blocks a real chat turn uses to write and persist an assistant message
 * (createUIMessageStream, the data-command-execution pill, and
 * buildAssistantPersistencePayload) so the reply streams, renders, and
 * survives reload identically to a real one.
 */

import { createId } from '@paralleldrive/cuid2';
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import { COMMAND_EXECUTION_PART_TYPE } from '@/lib/ai/core/command-processor';
import { buildAssistantPersistencePayload, type AssistantPersistencePayload } from '@/lib/ai/core/persistAssistantParts';
import { saveMessageToDatabase, saveGlobalAssistantMessageToDatabase } from '@/lib/ai/core/message-utils';
import { loadHelpAnswerText } from '@/lib/commands/help-answer';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * Shared stream shape: writes the "Using /help" pill and the answer text,
 * then hands the reconstructed parts to `persist` once the stream completes.
 * The two entry points below differ only in how (and under what id/role
 * columns) they persist — the writer side is identical.
 */
function buildHelpAnswerStream(
  messageId: string,
  answerText: string,
  originalMessages: UIMessage[],
  persist: (payload: AssistantPersistencePayload) => Promise<void>
): Response {
  const stream = createUIMessageStream({
    originalMessages,
    generateId: () => messageId,
    execute: async ({ writer }) => {
      writer.write({
        type: COMMAND_EXECUTION_PART_TYPE,
        id: `${messageId}-command-0`,
        data: { label: 'help', status: 'used' },
      });
      writer.write({ type: 'text-start', id: `${messageId}-text` });
      writer.write({ type: 'text-delta', id: `${messageId}-text`, delta: answerText });
      writer.write({ type: 'text-end', id: `${messageId}-text` });
    },
    onFinish: async ({ responseMessage }) => {
      if (!responseMessage) return;
      const payload = buildAssistantPersistencePayload(messageId, responseMessage.parts);
      try {
        await persist(payload);
      } catch (error) {
        loggers.ai.error('AI Chat API: Failed to save solo /help response', error as Error);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}

/** Page-chat entry point (apps/web/src/app/api/ai/chat/route.ts). */
export async function respondWithHelpAnswer(params: {
  userId: string;
  driveId: string | null;
  pageId: string;
  conversationId: string;
  originalMessages: UIMessage[];
}): Promise<Response> {
  const answerText = await loadHelpAnswerText(params.userId, params.driveId);
  const messageId = createId();

  return buildHelpAnswerStream(messageId, answerText, params.originalMessages, (payload) =>
    saveMessageToDatabase({
      messageId,
      pageId: params.pageId,
      conversationId: params.conversationId,
      userId: null,
      role: 'assistant',
      status: 'complete',
      ...payload,
    })
  );
}

/** Global assistant entry point (apps/web/src/app/api/ai/global/[id]/messages/route.ts). */
export async function respondWithGlobalHelpAnswer(params: {
  userId: string;
  driveId: string | null;
  conversationId: string;
  originalMessages: UIMessage[];
}): Promise<Response> {
  const answerText = await loadHelpAnswerText(params.userId, params.driveId);
  const messageId = createId();

  return buildHelpAnswerStream(messageId, answerText, params.originalMessages, (payload) =>
    saveGlobalAssistantMessageToDatabase({
      messageId,
      conversationId: params.conversationId,
      userId: params.userId,
      role: 'assistant',
      status: 'complete',
      ...payload,
    })
  );
}
