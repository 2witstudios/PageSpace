// Imago's messages model, and the apps/web shapes it is built from.
//
// The *Response types mirror what the route handlers actually return
// (apps/web/src/app/api/messages/conversations/route.ts, .../inbox/route.ts and
// .../sidebar/badges/route.ts): they are read from those handlers, not
// invented. The inbox shapes are the ones those handlers type themselves with.

import type { InboxItem, InboxResponse } from '@pagespace/lib/client-safe';

export type { InboxItem, InboxResponse };

/** The other person in a DM, as GET /api/messages/conversations joins them. */
export type ConversationUserResponse = {
  readonly id: string | null;
  readonly name: string | null;
  readonly email: string | null;
  readonly image: string | null;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
};

/** One of the viewer's DM conversations from GET /api/messages/conversations. */
export type ConversationResponse = {
  readonly id: string;
  readonly participant1Id: string;
  readonly participant2Id: string;
  readonly lastMessageAt: string | null;
  readonly lastMessagePreview: string | null;
  readonly participant1LastRead: string | null;
  readonly participant2LastRead: string | null;
  readonly createdAt: string | null;
  /** The viewer's own read watermark. */
  readonly lastRead: string | null;
  readonly otherUser: ConversationUserResponse;
  /** Unread messages from the other person. */
  readonly unreadCount: number;
};

export type ConversationsResponse = {
  readonly conversations: readonly ConversationResponse[];
  readonly pagination: {
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
    readonly limit: number;
  };
};

/** GET /api/sidebar/badges: the viewer's unread totals across every drive. */
export type SidebarBadges = {
  readonly dms: number;
  readonly channels: number;
  readonly files: number;
  readonly tasks: number;
  readonly calendar: number;
};

/** A CHANNEL page of the drive, with the viewer's unread count in it. */
export type ChannelThread = {
  readonly kind: 'channel';
  readonly id: string;
  readonly driveId: string;
  /** The page title, without a `#`. */
  readonly name: string;
  readonly lastMessageAt: string | null;
  readonly lastMessagePreview: string | null;
  readonly lastMessageSender: string | null;
  readonly unreadCount: number;
};

/** One of the viewer's DM conversations, named for the other person. */
export type DirectThread = {
  readonly kind: 'dm';
  readonly id: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly otherUserId: string | null;
  readonly lastMessageAt: string | null;
  readonly lastMessagePreview: string | null;
  /** UTC ISO: the viewer has read the conversation up to here. */
  readonly lastReadAt: string | null;
  readonly unreadCount: number;
};

export type MessageThread = ChannelThread | DirectThread;
