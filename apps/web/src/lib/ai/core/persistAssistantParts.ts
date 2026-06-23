import type { UIMessage } from 'ai';
import { synthesizeAssistantMessage } from '@/lib/ai/streams/synthesizeAssistantMessage';
import {
  extractMessageContent,
  extractToolCalls,
  extractToolResults,
} from '@/lib/ai/core/message-utils';
import type { UIMessagePart } from '@/lib/ai/core/stream-multicast-registry';

export interface AssistantPersistencePayload {
  content: string;
  toolCalls: ReturnType<typeof extractToolCalls> | undefined;
  toolResults: ReturnType<typeof extractToolResults> | undefined;
  uiMessage: UIMessage;
}

/**
 * Builds the persistence payload for an assistant message from its accumulated
 * stream parts. Used by both the execute-end durable path and the onFinish
 * path so neither can silently diverge in its DB representation.
 */
export function buildAssistantPersistencePayload(
  messageId: string,
  parts: UIMessagePart[],
): AssistantPersistencePayload {
  const uiMessage = synthesizeAssistantMessage(messageId, parts);
  const content = extractMessageContent(uiMessage);
  const rawToolCalls = extractToolCalls(uiMessage);
  const rawToolResults = extractToolResults(uiMessage);
  return {
    content,
    toolCalls: rawToolCalls.length > 0 ? rawToolCalls : undefined,
    toolResults: rawToolResults.length > 0 ? rawToolResults : undefined,
    uiMessage,
  };
}
