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
import { loadHelpAnswerText } from '@/lib/commands/help-answer';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * Shared stream shape: writes the "Using /help" pill and the answer text,
 * then hands the (already fully known — no incremental generation here)
 * final parts to `persist`. Persistence runs synchronously inside `execute`,
 * NOT in `onFinish`: the real routes' own comments document that `onFinish`
 * is coupled to the response stream and may never fire if the client
 * disconnects or backgrounds mid-request, whereas `execute` runs durably
 * server-side regardless of the client's connection state — the same
 * reasoning behind their own execute-end write. `persist` is expected to be
 * the caller's `saveTerminalAssistantMessage`-style wrapper, which re-checks
 * the conversation is still active before writing (see route.ts) — the same
 * guard every other terminal assistant write goes through.
 */
function buildHelpAnswerStream(
  messageId: string,
  answerText: string,
  originalMessages: UIMessage[],
  persist: (payload: AssistantPersistencePayload) => Promise<unknown>
): Response {
  const parts: UIMessage['parts'] = [
    {
      type: COMMAND_EXECUTION_PART_TYPE,
      id: `${messageId}-command-0`,
      data: { label: 'help', status: 'used' },
    },
    { type: 'text', text: answerText },
  ];

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

      try {
        await persist(buildAssistantPersistencePayload(messageId, parts));
      } catch (error) {
        loggers.ai.error('AI Chat API: Failed to save solo /help response', error as Error);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}

/** Page-chat entry point (apps/web/src/app/api/ai/chat/route.ts). */
export async function respondWithHelpAnswer(params: {
  senderId: string;
  driveId: string | null;
  originalMessages: UIMessage[];
  /**
   * The route's own saveTerminalAssistantMessage — reused (not duplicated)
   * so the /help reply gets the exact same active-conversation guard as
   * every other assistant write. Receives the generated messageId so the
   * caller's closure doesn't need to mint or thread its own.
   */
  persist: (payload: AssistantPersistencePayload, messageId: string) => Promise<unknown>;
}): Promise<Response> {
  const answerText = await loadHelpAnswerText(params.senderId, params.driveId);
  const messageId = createId();

  return buildHelpAnswerStream(messageId, answerText, params.originalMessages, (payload) =>
    params.persist(payload, messageId)
  );
}
