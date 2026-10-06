// Route answers for the messages tests, shaped like apps/web's handlers.

import type { ConversationResponse, InboxItem, SidebarBadges } from './message';
import type { DmMessageResponse } from './dm-message';
import type { ChannelMessageResponse, ChannelReactionResponse } from './post';

export const inboxChannel = (id: string, overrides: Partial<InboxItem> = {}): InboxItem => ({
  id,
  type: 'channel',
  name: `channel ${id}`,
  avatarUrl: null,
  lastMessageAt: null,
  lastMessagePreview: null,
  lastMessageSender: null,
  unreadCount: 0,
  driveId: 'd1',
  driveName: 'Drive one',
  ...overrides,
});

export const conversation = (
  id: string,
  overrides: Partial<ConversationResponse> = {},
): ConversationResponse => ({
  id,
  participant1Id: 'u1',
  participant2Id: 'u2',
  lastMessageAt: '2026-10-05T10:00:00.000Z',
  lastMessagePreview: 'see you',
  participant1LastRead: null,
  participant2LastRead: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastRead: null,
  otherUser: {
    id: 'u2',
    name: 'Grace Hopper',
    email: 'grace@example.com',
    image: 'https://img/grace.png',
    username: 'grace',
    displayName: 'Grace',
    avatarUrl: null,
  },
  unreadCount: 0,
  ...overrides,
});

export const badges = (overrides: Partial<SidebarBadges> = {}): SidebarBadges => ({
  dms: 0,
  channels: 0,
  files: 0,
  tasks: 0,
  calendar: 0,
  ...overrides,
});

/** A top-level channel post as GET /api/channels/[pageId]/messages returns it. */
export const channelMessage = (
  id: string,
  overrides: Partial<ChannelMessageResponse> = {},
): ChannelMessageResponse => ({
  id,
  content: `post ${id}`,
  createdAt: '2026-10-05T09:00:00.000Z',
  pageId: 'c1',
  userId: 'u2',
  editedAt: null,
  aiMeta: null,
  parentId: null,
  replyCount: 0,
  user: { id: 'u2', name: 'Grace Hopper', image: null },
  reactions: [],
  ...overrides,
});

export const channelReaction = (
  id: string,
  emoji: string,
  user: { readonly id: string; readonly name: string | null },
  createdAt = '2026-10-05T09:01:00.000Z',
): ChannelReactionResponse => ({ id, messageId: 'm', userId: user.id, emoji, createdAt, user });

/** A top-level DM message as GET /api/messages/[conversationId] returns it, sender joined. */
export const dmMessage = (id: string, overrides: Partial<DmMessageResponse> = {}): DmMessageResponse => ({
  id,
  conversationId: 'dm1',
  senderId: 'u2',
  content: `message ${id}`,
  createdAt: '2026-10-05T09:00:00.000Z',
  isEdited: false,
  editedAt: null,
  parentId: null,
  sender: { id: 'u2', name: 'Grace Hopper', image: null },
  reactions: [],
  ...overrides,
});
