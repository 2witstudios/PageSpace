/**
 * Decide whether the local surface should refresh its conversation in
 * response to a remote chat:undo_applied broadcast. Refresh only when the
 * event is from a different browser session AND its conversationId matches
 * the surface's currently-loaded conversation. Pure — no I/O.
 */
export const shouldRefreshAfterUndo = (
  payload: { conversationId: string; triggeredBy: { browserSessionId: string } },
  currentConversationId: string | null,
  localBrowserSessionId: string,
): boolean => {
  if (!currentConversationId) return false;
  if (payload.conversationId !== currentConversationId) return false;
  if (payload.triggeredBy.browserSessionId === localBrowserSessionId) return false;
  return true;
};
