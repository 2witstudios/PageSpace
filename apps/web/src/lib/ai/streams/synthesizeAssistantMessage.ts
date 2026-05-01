import type { UIMessage } from 'ai';

type UIMessagePart = UIMessage['parts'][number];

/**
 * Builds a minimal assistant `UIMessage` from a stream's accumulated parts
 * array. Used by surfaces that synthesize the in-flight remote stream as a
 * real assistant message bubble (so MessageRenderer + ToolCallRenderer
 * render identically to the originator's view).
 *
 * Pure — never mutates the input parts array.
 */
export const synthesizeAssistantMessage = (
  messageId: string,
  parts: readonly UIMessagePart[],
): UIMessage => ({
  id: messageId,
  role: 'assistant',
  parts: [...parts],
});
