/**
 * How many mounted subscriptions this TAB has on each `conv:<id>` room.
 *
 * Room membership is per-SOCKET and a tab has one socket, so it cannot be
 * managed per-component: `socket.leave(room)` issued by one unmounting
 * subscription evicts every other subscription in the same tab. Two
 * subscriptions on one conversation is the documented expected shape, not an
 * edge case — `GlobalChatContext` watches the current conversation app-wide
 * while a pane, `useAssistantSessionChat` or `useAgentChannelMultiplayer`
 * watches the same id — so the unconditional `leave_conversation` on unmount
 * silently starved the surviving surface (review finding — MAJOR 1). The
 * rev-gated protocol made it silent rather than obviously broken: the
 * survivor's watermark just stops advancing.
 *
 * THE ASYMMETRY IS THE POINT, and it is the same one `GlobalChatContext`
 * already states about delivery: a duplicate JOIN is harmless — the server
 * re-authorizes and `socket.join` on a room already joined is a no-op — while
 * a duplicate LEAVE is destructive. So joins stay unconditional and only the
 * leave is refcounted.
 *
 * Doing it the other way round (emit join only on 0→1) would be the subtly
 * wrong shape: this counter is keyed on conversation id alone, so when the
 * socket is replaced the count can stay above zero across the swap, and a
 * gated join would leave the NEW socket in no room at all. Unconditional joins
 * make a socket swap self-healing, which is what reconnect needs.
 *
 * Module-level for the same reason the rev-watch registry beside it is: the
 * fact being tracked is a property of the tab, not of any one component.
 */

/** Sockets differ only in the methods this module uses; typed structurally so tests need no io stub. */
interface RoomSocket {
  emit: (event: string, payload: string) => unknown;
}

const membership = new Map<string, number>();

/**
 * Take one reference on `conversationId`'s room and (always) join it.
 *
 * Idempotent per mount; pair with {@link releaseConversationRoom}.
 */
export const acquireConversationRoom = (socket: RoomSocket, conversationId: string): void => {
  membership.set(conversationId, (membership.get(conversationId) ?? 0) + 1);
  // Unconditional — see the module doc. A join is idempotent server-side and
  // re-runs `canAccessConversation`, so re-issuing one costs a check and
  // guarantees the CURRENT socket is in the room.
  socket.emit('join_conversation', conversationId);
};

/**
 * Drop one reference, leaving the room only when the last subscription goes.
 *
 * On a disconnected socket the emit is a no-op, which is correct — the server
 * already dropped every room for that socket.
 */
export const releaseConversationRoom = (socket: RoomSocket, conversationId: string): void => {
  const count = membership.get(conversationId);
  if (!count) return;
  if (count > 1) {
    membership.set(conversationId, count - 1);
    return;
  }
  membership.delete(conversationId);
  socket.emit('leave_conversation', conversationId);
};

/** Test seam: conversations this tab currently holds a room reference on. */
export const heldConversationRooms = (): string[] => [...membership.keys()];

/** Test seam — drops every reference. Never called in production. */
export const resetConversationRooms = (): void => membership.clear();
