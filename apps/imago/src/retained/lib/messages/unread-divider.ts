/** Where the "N new" divider sits in a conversation opened with unread incoming messages. */
export type UnreadMarker = { readonly messageId: string; readonly count: number };

type MarkerRow = { readonly id: string; readonly senderId: string; readonly isRead: boolean };

/**
 * The first incoming message the viewer had not read when the conversation loaded, and how
 * many incoming messages were unread. The viewer's own messages never count. Null when the
 * viewer is not yet known or nothing incoming was unread.
 */
export const unreadMarkerOf = (
  messages: readonly MarkerRow[],
  viewerId: string | undefined,
): UnreadMarker | null => {
  if (viewerId === undefined) return null;
  let first: string | null = null;
  let count = 0;
  for (const message of messages) {
    if (message.senderId === viewerId || message.isRead) continue;
    if (first === null) first = message.id;
    count += 1;
  }
  return first === null ? null : { messageId: first, count };
};
