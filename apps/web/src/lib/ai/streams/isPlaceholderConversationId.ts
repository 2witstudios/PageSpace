/**
 * True when `conversationId` is the channel-scoped placeholder a surface uses
 * before a real persisted conversation id arrives — e.g. `${pageId}-default`
 * for AiChatView. Used by the late-joiner reconciliation path to detect when
 * the synthesized assistant message needs to wait for the real id before
 * being appended.
 */
export const isPlaceholderConversationId = (
  conversationId: string | null | undefined,
  channelId: string,
): boolean => conversationId === `${channelId}-default`;
