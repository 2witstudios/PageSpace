import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { channelThreadsFrom, directThreadsFrom, inboxThreadsFrom } from './from-api';
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
          username: 'grace',
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
        username: null,
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

describe('inboxThreadsFrom()', () => {
  test('the unified inbox page', () => {
    const dm = { ...inboxChannel('m1', { name: 'Grace', lastMessagePreview: 'hi', unreadCount: 1 }), type: 'dm' as const, driveId: undefined };
    assert({
      given: 'a DM, a channel in drive d2, and a channel with no drive id',
      should: 'keep the DM and the channel with its own drive, and leave out a channel that names no drive',
      actual: inboxThreadsFrom([
        dm,
        inboxChannel('c1', { driveId: 'd2', lastMessageSender: 'Sam', lastMessagePreview: 'ship' }),
        inboxChannel('c2', { driveId: undefined }),
      ]).map((thread) => [thread.kind, thread.id, thread.kind === 'channel' ? thread.driveId : null, thread.unreadCount]),
      expected: [
        ['dm', 'm1', null, 1],
        ['channel', 'c1', 'd2', 0],
      ],
    });
  });
});

describe('agent marker (Agent Signup Phase 2c)', () => {
  const agentUser: ConversationUserResponse = {
    id: 'u3', name: 'PageSpace Support', email: null, image: null, username: null, displayName: null, avatarUrl: null, accountType: 'agent',
  };

  test('a DM with an agent', () => {
    assert({
      given: 'a conversation whose other person is an agent account, and the same in the unified inbox',
      should: 'carry the account type next to the unchanged name',
      actual: [
        directThreadsFrom([conversation('m1', { otherUser: agentUser })]).map(({ name, accountType }) => ({ name, accountType })),
        inboxThreadsFrom([{ ...inboxChannel('m2'), type: 'dm', name: 'PageSpace Support', accountType: 'agent' }]).map((thread) =>
          thread.kind === 'dm' ? { name: thread.name, accountType: thread.accountType } : null,
        ),
      ],
      expected: [[{ name: 'PageSpace Support', accountType: 'agent' }], [{ name: 'PageSpace Support', accountType: 'agent' }]],
    });
  });

  test('a DM with a person', () => {
    assert({
      given: 'a human other person, with or without an account type',
      should: 'carry it when sent and add nothing when absent',
      actual: [
        directThreadsFrom([conversation('m1', { otherUser: { ...agentUser, accountType: 'human' } })])[0]?.accountType,
        'accountType' in (directThreadsFrom([conversation('m1')])[0] ?? {}),
        'accountType' in (inboxThreadsFrom([{ ...inboxChannel('m2'), type: 'dm' }])[0] ?? {}),
      ],
      expected: ['human', false, false],
    });
  });
});
