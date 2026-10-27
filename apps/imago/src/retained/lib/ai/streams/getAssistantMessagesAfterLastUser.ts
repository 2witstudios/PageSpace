import type { UIMessage } from 'ai';

/**
 * The assistant replies a retry/regenerate discards: everything after the
 * last user message, filtered to role 'assistant'. Shared by
 * `useMessageActions.handleRetry` (deletes them server-side) and any caller
 * that needs to mirror the same removal into its own render state — keeping
 * one definition means a future change to "what retry clears" can't drift
 * between the two.
 */
export const getAssistantMessagesAfterLastUser = <T extends Pick<UIMessage, 'id' | 'role'>>(
  messages: readonly T[],
): T[] => {
  const lastUserMsgIndex = messages.map((m) => m.role).lastIndexOf('user');
  if (lastUserMsgIndex === -1) return [];
  return messages.slice(lastUserMsgIndex + 1).filter((m) => m.role === 'assistant');
};
