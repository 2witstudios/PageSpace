import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { applyInboxEvent, inboxEventOf, type InboxEvent } from './inbox-event';
import type { ChannelThread, DirectThread } from '../message-model/message';

const channel = (id: string, overrides: Partial<ChannelThread> = {}): ChannelThread => ({
  kind: 'channel',
  id,
  driveId: 'd1',
  name: id,
  lastMessageAt: null,
  lastMessagePreview: null,
  lastMessageSender: null,
  unreadCount: 0,
  ...overrides,
});

const direct = (id: string, overrides: Partial<DirectThread> = {}): DirectThread => ({
  kind: 'dm',
  id,
  name: id,
  avatarUrl: null,
  otherUserId: 'u2',
  lastMessageAt: null,
  lastMessagePreview: null,
  lastReadAt: null,
  unreadCount: 0,
  ...overrides,
});

const DRIVE = { kind: 'channel', driveId: 'd1' } as const;
const DMS = { kind: 'dm' } as const;

const channelUpdated = (id: string, overrides: Partial<InboxEvent> = {}): InboxEvent => ({
  operation: 'channel_updated',
  type: 'channel',
  id,
  driveId: 'd1',
  lastMessageAt: '2026-10-05T12:00:00.000Z',
  lastMessagePreview: 'new post',
  lastMessageSender: 'Ada',
  ...overrides,
});

describe('inboxEventOf()', () => {
  test('payloads realtime relays', () => {
    assert({
      given: 'a channel_updated payload as apps/web broadcasts it',
      should: 'read it as an inbox event',
      actual: inboxEventOf({
        operation: 'channel_updated',
        type: 'channel',
        id: 'c1',
        driveId: 'd1',
        lastMessageAt: '2026-10-05T12:00:00.000Z',
        lastMessagePreview: 'hi',
        lastMessageSender: 'Ada',
      }),
      expected: {
        operation: 'channel_updated',
        type: 'channel',
        id: 'c1',
        driveId: 'd1',
        lastMessageAt: '2026-10-05T12:00:00.000Z',
        lastMessagePreview: 'hi',
        lastMessageSender: 'Ada',
      },
    });

    assert({
      given: 'a read_status_changed payload for a DM',
      should: 'keep its explicit unread count',
      actual: inboxEventOf({ operation: 'read_status_changed', type: 'dm', id: 'm1', unreadCount: 0 }),
      expected: { operation: 'read_status_changed', type: 'dm', id: 'm1', unreadCount: 0 },
    });

    assert({
      given: 'a dm_updated payload with fields this layer does not use',
      should: 'drop them',
      actual: inboxEventOf({
        operation: 'dm_updated',
        type: 'dm',
        id: 'm1',
        lastMessageAt: '2026-10-05T12:00:00.000Z',
        attachmentMeta: null,
      }),
      expected: { operation: 'dm_updated', type: 'dm', id: 'm1', lastMessageAt: '2026-10-05T12:00:00.000Z' },
    });
  });

  test('payloads it cannot use', () => {
    assert({
      given: 'payloads that are not inbox events',
      should: 'give null for each',
      actual: [
        null,
        'channel_updated',
        { operation: 'deleted', type: 'channel', id: 'c1' },
        { operation: 'channel_updated', type: 'page', id: 'c1' },
        { operation: 'channel_updated', type: 'channel' },
        { operation: 'channel_updated', type: 'channel', id: '' },
        { operation: 'read_status_changed', type: 'dm', id: 'm1', unreadCount: '0' },
        { operation: 'read_status_changed', type: 'dm', id: 'm1', unreadCount: -1 },
        { operation: 'channel_updated', type: 'channel', id: 'c1', lastMessageAt: 5 },
      ].map(inboxEventOf),
      expected: [null, null, null, null, null, null, null, null, null],
    });
  });
});

describe('applyInboxEvent()', () => {
  test('a new post in a channel of this drive', () => {
    const rows = [channel('c1', { lastMessageAt: '2026-10-05T11:00:00.000Z' }), channel('c2', { unreadCount: 1 })];

    assert({
      given: 'channel_updated for a channel the list holds',
      should: 'count one more unread, show the post and move the channel to the top',
      actual: applyInboxEvent(rows, channelUpdated('c2'), DRIVE),
      expected: {
        rows: [
          channel('c2', {
            unreadCount: 2,
            lastMessageAt: '2026-10-05T12:00:00.000Z',
            lastMessagePreview: 'new post',
            lastMessageSender: 'Ada',
          }),
          channel('c1', { lastMessageAt: '2026-10-05T11:00:00.000Z' }),
        ],
        refetch: false,
      },
    });
  });

  test('the same event applied twice', () => {
    const once = applyInboxEvent([channel('c1')], channelUpdated('c1'), DRIVE).rows;

    assert({
      given: 'a second listener applying the event the first one already applied',
      should: 'not count the post twice',
      actual: applyInboxEvent(once, channelUpdated('c1'), DRIVE).rows[0].unreadCount,
      expected: 1,
    });

    assert({
      given: 'a different post at the same moment',
      should: 'count it',
      actual: applyInboxEvent(once, channelUpdated('c1', { lastMessagePreview: 'another' }), DRIVE).rows[0]
        .unreadCount,
      expected: 2,
    });
  });

  test('an explicit unread count', () => {
    assert({
      given: 'an update carrying the server’s unread count',
      should: 'use that count',
      actual: applyInboxEvent([channel('c1', { unreadCount: 4 })], channelUpdated('c1', { unreadCount: 7 }), DRIVE)
        .rows[0].unreadCount,
      expected: 7,
    });
  });

  test('read status', () => {
    const read: InboxEvent = { operation: 'read_status_changed', type: 'channel', id: 'c1', driveId: 'd1', unreadCount: 0 };

    assert({
      given: 'the viewer reading a channel (here or in another tab)',
      should: 'clear its unread count and leave its place and post alone',
      actual: applyInboxEvent(
        [channel('c2', { lastMessageAt: '2026-10-05T12:00:00.000Z' }), channel('c1', { unreadCount: 5, lastMessagePreview: 'old' })],
        read,
        DRIVE,
      ),
      expected: {
        rows: [
          channel('c2', { lastMessageAt: '2026-10-05T12:00:00.000Z' }),
          channel('c1', { unreadCount: 0, lastMessagePreview: 'old' }),
        ],
        refetch: false,
      },
    });

    assert({
      given: 'read status for a thread the list does not hold',
      should: 'change nothing and fetch nothing',
      actual: applyInboxEvent([channel('c2', { unreadCount: 1 })], read, DRIVE),
      expected: { rows: [channel('c2', { unreadCount: 1 })], refetch: false },
    });

    assert({
      given: 'read status with no count',
      should: 'clear the count',
      actual: applyInboxEvent(
        [direct('m1', { unreadCount: 3 })],
        { operation: 'read_status_changed', type: 'dm', id: 'm1' },
        DMS,
      ).rows[0].unreadCount,
      expected: 0,
    });
  });

  test('a post in a thread the list does not hold', () => {
    const rows = [channel('c1')];

    assert({
      given: 'channel_updated for a channel of this drive the list has not loaded',
      should: 'keep the rows and ask for a refetch',
      actual: applyInboxEvent(rows, channelUpdated('c-new'), DRIVE),
      expected: { rows, refetch: true },
    });
  });

  test('events for other lists', () => {
    const rows = [channel('c1', { unreadCount: 1 })];

    assert({
      given: 'a channel event from another drive',
      should: 'change nothing and fetch nothing',
      actual: applyInboxEvent(rows, channelUpdated('c1', { driveId: 'd2' }), DRIVE),
      expected: { rows, refetch: false },
    });

    assert({
      given: 'a DM event on a channel list',
      should: 'change nothing and fetch nothing',
      actual: applyInboxEvent(rows, { operation: 'dm_updated', type: 'dm', id: 'c1' }, DRIVE),
      expected: { rows, refetch: false },
    });

    const dms = [direct('m1')];

    assert({
      given: 'a channel event on the DM list',
      should: 'change nothing and fetch nothing',
      actual: applyInboxEvent(dms, channelUpdated('m1'), DMS),
      expected: { rows: dms, refetch: false },
    });

    assert({
      given: 'a thread reply, which classic keeps out of the top-level count',
      should: 'change nothing and fetch nothing',
      actual: applyInboxEvent(rows, { operation: 'thread_updated', type: 'channel', id: 'c1' }, DRIVE),
      expected: { rows, refetch: false },
    });
  });

  test('a new DM message', () => {
    assert({
      given: 'dm_updated for a conversation the list holds',
      should: 'count one more unread, show the message and move it to the top',
      actual: applyInboxEvent(
        [direct('m2', { lastMessageAt: '2026-10-05T11:00:00.000Z' }), direct('m1')],
        { operation: 'dm_updated', type: 'dm', id: 'm1', lastMessageAt: '2026-10-05T12:00:00.000Z', lastMessagePreview: 'ping' },
        DMS,
      ).rows,
      expected: [
        direct('m1', { unreadCount: 1, lastMessageAt: '2026-10-05T12:00:00.000Z', lastMessagePreview: 'ping' }),
        direct('m2', { lastMessageAt: '2026-10-05T11:00:00.000Z' }),
      ],
    });
  });

  test('an update without a preview', () => {
    assert({
      given: 'an attachment-only message (no preview)',
      should: 'keep the previous preview and still count it',
      actual: applyInboxEvent(
        [direct('m1', { lastMessagePreview: 'earlier' })],
        { operation: 'dm_updated', type: 'dm', id: 'm1', lastMessageAt: '2026-10-05T12:00:00.000Z' },
        DMS,
      ).rows[0],
      expected: direct('m1', { unreadCount: 1, lastMessageAt: '2026-10-05T12:00:00.000Z', lastMessagePreview: 'earlier' }),
    });
  });
});
