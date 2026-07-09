import type { UIMessage } from 'ai';

type UIMessagePart = UIMessage['parts'][number];

/**
 * Builds a minimal assistant `UIMessage` from a stream's accumulated parts
 * array. Used by surfaces that synthesize the in-flight remote stream as a
 * real assistant message bubble (so MessageRenderer + ToolCallRenderer
 * render identically to the originator's view).
 *
 * When `createdAt` is provided (the stream's start time), it is attached so
 * the bubble carries a timestamp footer that matches its persisted neighbors;
 * omitted entirely when absent, so a synthesized bubble degrades to today's
 * timestamp-less behavior rather than an `Invalid Date`.
 *
 * Pure — never mutates the input parts array.
 */
export const synthesizeAssistantMessage = (
  messageId: string,
  parts: readonly UIMessagePart[],
  createdAt?: Date,
): UIMessage & { createdAt?: Date } => ({
  id: messageId,
  role: 'assistant',
  parts: [...parts],
  ...(createdAt ? { createdAt } : {}),
});
