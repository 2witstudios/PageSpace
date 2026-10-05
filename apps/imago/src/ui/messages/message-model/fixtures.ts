// Route answers for the messages tests, shaped like apps/web's handlers.

import type { ConversationResponse, InboxItem, SidebarBadges } from './message';

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
