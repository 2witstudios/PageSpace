// apps/web's messaging answers, mapped into imago's messages model.

import type { ChannelThread, ConversationResponse, DirectThread, InboxItem } from './message';

/**
 * A drive's channels as GET /api/inbox?type=channel&driveId= returns them:
 * the drive's CHANNEL pages the viewer may see, newest post first, each with
 * the viewer's unread count. Which channels those are is the server's call.
 */
export const channelThreadsFrom = (driveId: string, items: readonly InboxItem[]): readonly ChannelThread[] =>
  items.map((item) => ({
    kind: 'channel',
    id: item.id,
    driveId,
    name: item.name,
    lastMessageAt: item.lastMessageAt,
    lastMessagePreview: item.lastMessagePreview,
    lastMessageSender: item.lastMessageSender,
    unreadCount: item.unreadCount,
  }));

/**
 * The viewer's DMs from GET /api/messages/conversations, each named for the
 * other person as classic names them (display name, then name), with the
 * username before giving up on a missing user row.
 */
export const directThreadsFrom = (conversations: readonly ConversationResponse[]): readonly DirectThread[] =>
  conversations.map(({ id, otherUser, lastMessageAt, lastMessagePreview, lastRead, unreadCount }) => ({
    kind: 'dm',
    id,
    name: otherUser.displayName || otherUser.name || otherUser.username || '',
    avatarUrl: otherUser.image || otherUser.avatarUrl,
    otherUserId: otherUser.id,
    lastMessageAt,
    lastMessagePreview,
    lastReadAt: lastRead,
    unreadCount,
  }));
