/** The fields of a channel message that decide whether it counts as unread. */
export type UnreadCandidate = {
  readonly id: string;
  readonly createdAt: string | Date;
  readonly userId?: string | null;
};

/** Where the "<n> new" divider sits: before the first unread message, counting all unread. */
export type UnreadBoundary = { readonly id: string; readonly count: number };

const toMillis = (value: string | Date): number =>
  value instanceof Date ? value.getTime() : Date.parse(value);

/**
 * The unread divider for a channel as loaded. A message is unread when it arrived after the
 * viewer's lastReadAt (the watermark as it was when the channel opened), was not sent by the
 * viewer, and is saved (not an optimistic `temp-` row). Agent and webhook posts count too. Null when nothing is unread or the
 * channel has never been read, so a brand-new viewer is not greeted by a wall of "new".
 */
export const unreadBoundary = (
  messages: readonly UnreadCandidate[],
  lastReadAt: string | null,
  viewerId: string | null,
): UnreadBoundary | null => {
  if (lastReadAt === null) return null;
  const watermark = Date.parse(lastReadAt);
  const unread = messages.filter(
    (message) =>
      !message.id.startsWith('temp-') &&
      !(viewerId !== null && message.userId === viewerId) &&
      toMillis(message.createdAt) > watermark,
  );
  const first = unread[0];
  return first ? { id: first.id, count: unread.length } : null;
};
