import type { UIMessage } from 'ai';

type UIMessagePart = UIMessage['parts'][number];

/**
 * Builds a minimal assistant `UIMessage` from a stream's accumulated parts
 * array. Used by surfaces that synthesize the in-flight remote stream as a
 * real assistant message bubble (so MessageRenderer + ToolCallRenderer
 * render identically to the originator's view).
 *
 * When `startedAt` (the stream's ISO start time) is provided, it is attached
 * as a `createdAt` Date so the bubble carries a timestamp footer that matches
 * its persisted neighbors. It is omitted entirely when absent or unparseable,
 * so a synthesized bubble degrades to today's timestamp-less behavior rather
 * than rendering an `Invalid Date`.
 *
 * Pure — never mutates the input parts array.
 */
export const synthesizeAssistantMessage = (
  messageId: string,
  parts: readonly UIMessagePart[],
  startedAt?: string,
): UIMessage & { createdAt?: Date } => {
  const createdAt = startedAt ? new Date(startedAt) : undefined;
  const validCreatedAt = createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : undefined;
  return {
    id: messageId,
    role: 'assistant',
    parts: [...parts],
    ...(validCreatedAt ? { createdAt: validCreatedAt } : {}),
  };
};
