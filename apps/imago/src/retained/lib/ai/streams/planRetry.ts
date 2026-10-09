import type { UIMessage } from 'ai';
import type { RenderedMessage } from './selectRenderedMessages';
import { getAssistantMessagesAfterLastUser } from './getAssistantMessagesAfterLastUser';

export interface PlanRetryResult {
  assistantIdsToDelete: string[];
  lastUserMessage: UIMessage | undefined;
}

/**
 * Pure Retry decision over the SELECTOR output (`selectRenderedMessages`),
 * not useChat's local array — after a reload that array is empty, but Retry
 * must still work from cache. Refuses to plan any deletion while a stream is
 * live anywhere in the rendered list: an automatic/manual delete must never
 * race a still-writing server run (double-generation, double billing).
 */
export const planRetry = (renderedMessages: readonly RenderedMessage[]): PlanRetryResult => {
  const hasLiveStream = renderedMessages.some((r) => r.mode === 'streaming');
  if (hasLiveStream) {
    return { assistantIdsToDelete: [], lastUserMessage: undefined };
  }

  const settled = renderedMessages.map((r) => r.message);
  const assistantIdsToDelete = getAssistantMessagesAfterLastUser(settled).map((m) => m.id);
  const lastUserMessage = settled.filter((m) => m.role === 'user').slice(-1)[0];

  return { assistantIdsToDelete, lastUserMessage };
};
