import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { channelThreadsFrom, directThreadsFrom } from './from-api';
import { conversation, inboxChannel } from './fixtures';
import type { ConversationUserResponse } from './message';

describe('channelThreadsFrom()', () => {
  test('a drive inbox page', () => {
    assert({
      given: "a drive's channels from /api/inbox",
      should: 'give one channel thread each, in the order the server sent',
      actual: channelThreadsFrom('d1', [
        inboxChannel('c2', { unreadCount: 3, lastMessageAt: '2026-10-05T10:00:00.000Z', lastMessagePreview: 'hi', lastMessageSender: 'Ada' }),
        inboxChannel('c1'),
      ]),
      expected: [
        {
          kind: 'channel',
          id: 'c2',
          driveId: 'd1',
          name: 'channel c2',
          lastMessageAt: '2026-10-05T10:00:00.000Z',
          lastMessagePreview: 'hi',
          lastMessageSender: 'Ada',
          unreadCount: 3,
        },
        {
          kind: 'channel',
          id: 'c1',
          driveId: 'd1',
          name: 'channel c1',
          lastMessageAt: null,
          lastMessagePreview: null,
          lastMessageSender: null,
          unreadCount: 0,
        },
      ],
    });
  });
});

describe('directThreadsFrom()', () => {
  test('a conversations page', () => {
    assert({
      given: 'a conversation from /api/messages/conversations',
      should: 'name it for the other person and keep the viewer’s read state',
      actual: directThreadsFrom([conversation('m1', { unreadCount: 2, lastRead: '2026-10-05T09:00:00.000Z' })]),
      expected: [
        {
          kind: 'dm',
          id: 'm1',
          name: 'Grace',
          avatarUrl: 'https://img/grace.png',
          otherUserId: 'u2',
          lastMessageAt: '2026-10-05T10:00:00.000Z',
          lastMessagePreview: 'see you',
          lastReadAt: '2026-10-05T09:00:00.000Z',
          unreadCount: 2,
        },
      ],
    });
  });

  test('naming', () => {
    const named = (otherUser: Partial<ConversationUserResponse>) =>
      directThreadsFrom([conversation('m1', { otherUser: { ...conversation('m1').otherUser, ...otherUser } })])[0];

    assert({
      given: 'no display name',
      should: 'use the person’s name, as classic does',
      actual: named({ displayName: null }).name,
      expected: 'Grace Hopper',
    });

    assert({
      given: 'no display name or name',
      should: 'use the username',
      actual: named({ displayName: null, name: null }).name,
      expected: 'grace',
    });

    assert({
      given: 'a missing user row',
      should: 'give an empty name rather than a stored value',
      actual: named({ id: null, displayName: null, name: null, username: null, email: null, image: null, avatarUrl: null }),
      expected: {
        kind: 'dm',
        id: 'm1',
        name: '',
        avatarUrl: null,
        otherUserId: null,
        lastMessageAt: '2026-10-05T10:00:00.000Z',
        lastMessagePreview: 'see you',
        lastReadAt: null,
        unreadCount: 0,
      },
    });

    assert({
      given: 'no uploaded image',
      should: 'fall back to the profile avatar, as /api/inbox does',
      actual: named({ image: null, avatarUrl: 'https://img/profile.png' }).avatarUrl,
      expected: 'https://img/profile.png',
    });
  });
});
