import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { DirectThread, ChannelThread } from '../message-model/message';
import { inboxKeeps, inboxRowOf, inboxWhen } from './inbox-rows';

const now = new Date(2026, 9, 12, 12, 0);
const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0).toISOString();

const channel: ChannelThread = {
  kind: 'channel',
  id: 'c1',
  driveId: 'd1',
  name: 'launch-ops',
  lastMessageAt: at(12, 9),
  lastMessagePreview: 'Can someone confirm the 18th?',
  lastMessageSender: 'Sam',
  unreadCount: 4,
};

const dm: DirectThread = {
  kind: 'dm',
  id: 'm1',
  name: 'Dana',
  avatarUrl: null,
  otherUserId: null,
  lastMessageAt: at(11, 9),
  lastMessagePreview: 'Status page draft is in the doc',
  lastReadAt: null,
  unreadCount: 0,
};

describe('inboxKeeps()', () => {
  test('the filters', () => {
    assert({
      given: 'a channel and a DM under each Show filter',
      should: 'keep both under All, only the channel under Channels and only the DM under Direct',
      actual: (['all', 'channels', 'direct'] as const).map((filter) => [inboxKeeps(filter, channel), inboxKeeps(filter, dm)]),
      expected: [
        [true, true],
        [true, false],
        [false, true],
      ],
    });
  });

  test('scoped to a drive', () => {
    assert({
      given: 'the inbox scoped to the channel’s drive, to another drive, and to every drive',
      should: 'drop other drives’ channels and always keep the DMs',
      actual: (['d1', 'd2', null] as const).map((driveId) => [inboxKeeps('all', channel, driveId), inboxKeeps('all', dm, driveId)]),
      expected: [
        [true, true],
        [false, true],
        [true, true],
      ],
    });
  });
});

describe('inboxWhen()', () => {
  test('a time from today, yesterday, this week and older', () => {
    assert({
      given: 'a thread last posted today, yesterday, four days ago and a month ago',
      should: 'show the clock time, "Yesterday", the weekday, then the date; empty when never posted',
      actual: [
        inboxWhen(at(12, 9), now) !== '',
        inboxWhen(at(11, 9), now),
        inboxWhen(at(8, 9), now),
        inboxWhen(at(1, 9), now),
        inboxWhen(null, now),
      ],
      expected: [true, 'Yesterday', new Date(at(8, 9)).toLocaleDateString([], { weekday: 'short' }), new Date(at(1, 9)).toLocaleDateString([], { month: 'short', day: 'numeric' }), ''],
    });
  });
});

describe('inboxRowOf()', () => {
  test('a channel row', () => {
    assert({
      given: 'a channel with a sender and a preview',
      should: 'link to its drive and channel, prefix the preview with the sender and keep the unread count',
      actual: (({ href, preview, unreadCount, name }) => ({ href, preview, unreadCount, name }))(inboxRowOf(channel, now)),
      expected: {
        href: '/d1/messages/c1',
        preview: 'Sam: Can someone confirm the 18th?',
        unreadCount: 4,
        name: 'launch-ops',
      },
    });
  });

  test('a DM row and a thread never posted in', () => {
    assert({
      given: 'a DM whose preview has no sender, and a DM never posted in with no name',
      should: 'show the preview alone, link to /dm, and name a missing user "Unknown user" with "No messages yet"',
      actual: [
        inboxRowOf(dm, now).preview,
        inboxRowOf(dm, now).href,
        inboxRowOf({ ...dm, name: '', lastMessagePreview: null, lastMessageAt: null }, now).name,
        inboxRowOf({ ...dm, lastMessagePreview: null, lastMessageAt: null }, now).preview,
      ],
      expected: ['Status page draft is in the doc', '/dm/m1', 'Unknown user', 'No messages yet'],
    });
  });
});
