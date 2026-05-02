/**
 * Decide whether to prepend a remotely-added conversation onto the local
 * history list. True only when the event is from a different browser session
 * AND the conversation id is not already present (originator's POST response
 * already added it; race-condition dedup). Pure — no I/O.
 */
export const shouldPrependConversation = (
  payload: { conversation: { id: string }; triggeredBy: { browserSessionId: string } },
  localBrowserSessionId: string,
  currentConversations: readonly { id: string }[],
): boolean => {
  if (payload.triggeredBy.browserSessionId === localBrowserSessionId) return false;
  if (currentConversations.some((c) => c.id === payload.conversation.id)) return false;
  return true;
};
