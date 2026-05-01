import type { UIMessage } from 'ai';

/**
 * Builds a minimal assistant `UIMessage` from a stream's accumulated text.
 * Used by surfaces that synthesize the completed assistant message locally on
 * `onStreamComplete` instead of waiting for a server-side conversation refresh.
 */
export const synthesizeAssistantMessage = (
  messageId: string,
  text: string,
): UIMessage => ({
  id: messageId,
  role: 'assistant',
  parts: [{ type: 'text', text }],
});
