/**
 * Stale-response guard for conversation message loads.
 *
 * Returns true only when the fetch that just resolved is for the conversation
 * the view currently wants. When the user switches conversation while a fetch
 * is in-flight, `inFlightConversationId` (a ref updated on every new request)
 * will have moved on, and this returns false — the caller should drop the
 * stale result rather than clobbering the newer conversation's messages.
 */
export const shouldApplyLoadedMessages = (
  requestedConversationId: string,
  inFlightConversationId: string | null,
): boolean => requestedConversationId === inFlightConversationId;
