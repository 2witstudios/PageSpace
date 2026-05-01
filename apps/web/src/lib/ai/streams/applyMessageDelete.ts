import type { UIMessage } from 'ai';

/**
 * Apply a remote delete broadcast to a local messages array. Returns a new
 * array with the matched message filtered out, or returns the input reference
 * unchanged when the messageId is not present. Pure — never mutates input.
 */
export const applyMessageDelete = <T extends UIMessage>(
  messages: T[],
  messageId: string,
): T[] => {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx < 0) return messages;
  return messages.filter((m) => m.id !== messageId);
};
